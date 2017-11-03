import lru from 'lru-cache';
import { each, map } from 'lodash';
import { uiModules } from 'ui/modules';
import { countStrategyValidator } from 'ui/kibi/meta/strategy_validator';

function KibiMetaProvider(createNotifier, kibiState, es, config) {

  const notify = createNotifier({
    location: 'Kibi meta service'
  });

  class KibiMeta {
    constructor({
      enableCache = true,
      cacheSize = 500,
      cacheMaxAge = 1000 * 60
    } = {}) {

      // map to cache the counts based on generated query
      this.cache = null;

      if (enableCache) {
        const defaultSettings = {
          max: cacheSize,
          maxAge: cacheMaxAge
        };
        const lruCache = lru(defaultSettings);
        // we wrap here to be able to change cache lib if needed
        const cache = {
          set: function (key, value, maxAge) {
            lruCache.set(key, value, maxAge);
          },
          get: function (key) {
            return lruCache.get(key);
          },
          reset: function () {
            lruCache.reset();
          }
        };
        this.cache = cache;
      }

      // in order to make sure we are not executing
      // a callback from a previous object for particular id
      // while later one was already executed
      // we need to track this in the counters maps
      this.counters = {};

      this.queues = {};
      this.strategies = {};
      const dashboardStrategy = config.get('kibi:countFetchingStrategyDashboards');
      this._validateStrategy(dashboardStrategy);
      this.setStrategy(dashboardStrategy);
      this.dashboardStrategyName = dashboardStrategy.name;
      const relFilterStrategy = config.get('kibi:countFetchingStrategyRelationalFilters');
      this._validateStrategy(relFilterStrategy);
      this.setStrategy(relFilterStrategy);
      this.relFilterStrategyName = relFilterStrategy.name;
    }

    flushCache() {
      this.cache.reset();
    }

    flushQueues() {
      each(this.queues, (o, key) => {
        this.queues[key] = [];
      });
    }

    _validateStrategy(strategy) {
      try {
        countStrategyValidator(strategy);
      } catch (e) {
        notify.error(e.message);
      }
    }

    setStrategy(strategy) {
      this.strategies[strategy.name] = strategy;
      // set counters
      this._setDefaultMeta(strategy.name);
      // set queue
      this._setQueue(strategy.name);
    }

    _setDefaultMeta(strategyName) {
      this.strategies[strategyName]._requestInProgress = 0;
    }

    _setQueue(strategyName) {
      this.queues[strategyName] = [];
    }

    updateStrategy(strategyName, propertyName, propertyValue) {
      this.strategies[strategyName][propertyName] = propertyValue;
    }

    /*
     * Where dashboards is an array of objects in a following format
     * {
     *   definition: object with a query property
     *   callback: function to be executed when count is ready
     * }
     *
     * This method only adds to the queue
     */
    getMetaForDashboards(dashboards = []) {
      each(dashboards, d => {
        this._addToQueue(d, this.dashboardStrategyName);
      });
      this._processSingleQueue(this.dashboardStrategyName);
    }

    /*
     * Where buttons is an array of objects in a following format
     * {
     *   definition: object with a query property
     *   callback: function (error, meta) {} - Function to be executed when count is ready
     * }
     *
     * Meta contains following properties
     *   hits
     *   status
     *   took
     *   planner
     *   timed_out
     *   _shards
     */
    getMetaForRelationalButtons(buttons = []) {
      each(buttons, b => {
        this._addToQueue(b, this.relFilterStrategyName);
      });
      this._processSingleQueue(this.relFilterStrategyName);
    }

    _addToQueue(o, queueName) {
      this._checkDefinition(o, queueName);
      this.queues[queueName].push(o);
    }

    _checkDefinition(d, queueName) {
      if (!d.definition) {
        throw new Error(
          'Wrong ' + queueName + ' definition: ' + JSON.stringify(d) +
          '. Defintion requires a definition object like { id: ID, query: query}'
        );
      }
      if (!d.definition.id || !d.definition.query) {
        throw new Error(
          'Wrong ' + queueName + ' definition object: ' + JSON.stringify(d.definition) +
          '. Defintion object requires two mandatory properties: id and query'
        );
      }
    }

    _processQueues() {
      each(this.queues, (key, value) => {
        this._processSingleQueue(key);
      });
    }

    _updateCounter(id, type) {
      if (!this.counters[id]) {
        this.counters[id] = {};
      }
      if (!this.counters[id][type]) {
        this.counters[id][type] = 1;
      } else {
        this.counters[id][type]++;
      }
      return this.counters[id][type];
    }

    _processSingleQueue(queueName) {
      const strategy = this.strategies[queueName];
      // check if there is request in progress
      if (strategy._requestInProgress >= strategy.parallelRequests) {
        // do nothing as it will call _processSingleQueue once request is finished
        return;
      }

      const queue = this.queues[queueName];

      // sort queue by target index name
      queue.sort(function (a, b) {
        const queryA = a.definition.query;
        const queryB = b.definition.query;
        const queryAParts = queryA.split('\n');
        const queryBParts = queryB.split('\n');
        const metaPartA = queryAParts[0];
        const metaPartB = queryBParts[0];
        const metaA = JSON.parse(metaPartA);
        const metaB = JSON.parse(metaPartB);
        const indexA = metaA.index;
        const indexB = metaB.index;
        if (indexA instanceof Array) {
          indexA.sort();
        }
        if (indexB instanceof Array) {
          indexB.sort();
        }
        const aString = JSON.stringify(indexA);
        const bString = JSON.stringify(indexB);
        return aString.localeCompare(bString);
      });

      // take a number of queries to process
      const toProcess = [];
      const n = Math.min(strategy.batchSize, queue.length);
      for (let i = 0; i < n; i++) {
        const o = queue.shift();
        if (this.cache && this.cache.get(o.definition.query)) {
          o.callback(undefined, this.cache.get(o.definition.query));
          continue;
        }
        toProcess.push(o);
      }

      // if there is nothing inside toProcess
      // and the queue is not empty continue to process the queue
      // else exit
      if (toProcess.length === 0) {
        if (queue.length > 0) {
          this._processSingleQueue(queueName);
        } else {
          return;
        }
      }

      // fire the msearch
      const query = map(toProcess, o => o.definition.query).join('');

      // set counters before sending the request
      each(toProcess, o =>{
        o._sentCounter = this._updateCounter(o.definition.id, 'sent');
      });

      strategy._requestInProgress++;

      const payload = {
        body: query,
        getMeta: queueName // ?getMeta= has no meaning it is just useful to filter by specific strategy
      };

      es
      .msearch(payload)
      .then(data => {
        strategy._requestInProgress--;
        each(data.responses, (hit, i) => {
          const o = toProcess[i];
          if (this.cache) {
            this.cache.set(o.definition.query, hit);
          }

          o._callbackCounter = this._updateCounter(o.definition.id, 'callback');
          if (o._sentCounter < o._callbackCounter) {
            // do not execute callback from this old request which have just arrived;
            return;
          }
          o.callback(undefined, hit);
        });

        // maybe move this to finally
        if (queue.length > 0) {
          this._processSingleQueue(queueName);
        }
      }).catch(err => {
        strategy._requestInProgress--;
        // retry a number of times according to strategy but then stop
        each(toProcess, o => {
          if (!o.retried) {
            o.retried = 1;
          } else {
            o.retried++;
          }
          if (o.retried <= strategy.retryOnError) {
            // put back to queue
            queue.push(o);
          } else {
            // report error to the user
            o.callback(
              new Error('Could not fetch meta for ' + JSON.stringify(o) + ' after retrying ' + strategy.retryOnError + ' times')
            );
          }
        });

        // maybe move this to finally
        if (queue.length > 0) {
          this._processSingleQueue(queueName);
        }
      });
    }

  }

  return new KibiMeta();
}

uiModules
.get('kibana/kibi_counts')
.service('kibiMeta', Private => Private(KibiMetaProvider));
