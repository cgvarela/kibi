import _ from 'lodash';

/**
 * Returns the "field" value to use in ES requests for a given
 * input field.
 */
export function fieldSpec(field) {
  return field.scripted
    ? { script: { inline: field.script, lang: field.lang } }
    : { field: field.name };
}

export function queryEsType(mappings, field) {
  if(field.esType) { return Promise.resolve(field.esType); }

  // NOTE: Mappings *promises* are cached, so asking once per field
  //       and in full concurrency (Promise.all) is ok

  return mappings.getMapping(field.indexPattern.id)
    .then(indexMaps => {
      let esType;

      _.forOwn(indexMaps, indexMap => {
        _.forOwn(indexMap.mappings, typeMap => {
          const prop = typeMap.properties[field.name];
          if(!prop) { return; }

          esType = prop.type;
          return false;
        });

        return !esType;
      });

      return esType;
    });
}

/**
 * Returns a promise to whether the input field is analyzed text.
 */
export function queryIsAnalyzed(mappings, field) {
  if(field.esType && field.esType !== 'string') {
    return Promise.resolve(field.esType === 'text');
  }

  // TODO - The following should be removed moving to ES/Kibana
  // versions 6.x. It's currently necessary because:
  //
  //  - `analyzed` has been removed from field attributes
  //  - 2.x `string` datatype is still working in ES 5.x
  //
  // Once ES 6.x is adopted, 2.x datasets will need to be reindexed
  // to exclude `string`, and the entire function should be
  // de-promisified.

  return mappings.getMapping(field.indexPattern.id)
    .then(indexMaps =>
      _.some(indexMaps, indexMap =>
        _.some(indexMap.mappings, typeMap => {
          const prop = typeMap.properties[field.name];
          if(!prop) { return false; }

          switch (prop.type) {
            case 'text':
              return true;

            case 'string':
              return (prop.index !== 'not_analyzed');

            default:
              return false;
          }
        })
      )
    );
}

