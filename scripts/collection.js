#!/usr/bin/env node
'use strict';

var assert = require('assert');
var _ = require('lodash');
var fs = require('fs');
var exec = require('child_process').execSync;
var Path = require('path');
var jp = require('json-pointer');
var jsonPath = require('jsonpath');
var glob = require('glob')
var editor = require('editor');
var async = require('async')
var sortobject = require('deep-sort-object');
var converter = require('api-spec-converter');
var parseDomain = require('parse-domain');
var mkdirp = require('mkdirp').sync;
var mktemp = require('mktemp').createFileSync;
var jsonPatch = require('json-merge-patch');
var Request = require('request');
var MimeLookup = require('mime-lookup');
var MIME = new MimeLookup(require('mime-db'));
var URI = require('urijs');
var csvStringify = require('csv-stringify');

var jsondiffpatch = require('jsondiffpatch').create({
  arrays: {
    includeValueOnMove: true
  },
  objectHash: function(obj) {
    // this function is used only to when objects are not equal by ref
    // add swagger specific properties
    return obj._id || obj.id || obj.name || obj.operationId;
  }
});

var program = require('commander');

var errExitCode = 255;
program
  .option('-0', 'allways return 0 as exit code', function () {
    errExitCode = 0;
  });

program
  .command('urls')
  .description('show source url for specs')
  .action(urlsCollection);

program
  .command('update')
  .description('run update')
  .arguments('[DIR]')
  .action(updateCollection);

program
  .command('validate')
  .description('validate collection')
  .action(validateCollection);

program
  .command('google')
  .description('add new Google APIs')
  .action(updateGoogle);

program
  .command('cache')
  .description('cache external resources')
  .arguments('<SPEC_ROOT_URL>')
  .action(cacheResources);

program
  .command('api')
  .description('generate API')
  .arguments('<SPEC_ROOT_URL>')
  .action(generateAPI);

program
  .command('csv')
  .description('generate CSV list')
  .action(generateCSV);

program
  .command('apisjson')
  .description('generate APIs.json file')
  .arguments('<SPEC_ROOT_URL>')
  .action(generateAPIsJSON);

program
  .command('add')
  .description('add new spec')
  .option('-f, --fixup', 'try to fix spec')
  .option('-s, --service <NAME>', 'supply service name')
  .arguments('<TYPE> <URL>')
  .action(addToCollection);

program.parse(process.argv);

function urlsCollection() {
  _.each(getSpecs(), function (swagger) {
    console.log(getOriginUrl(swagger));
  });
}

function updateCollection(dir) {
  var specs = getSpecs(dir);
  async.forEachOfSeries(specs, function (swagger, filename, asyncCb) {
    var exPatch = {info: {}};
    var serviceName = getServiceName(swagger);
    var type = getSpecType(swagger);
    if (type !== 'google' && serviceName)
      exPatch.info['x-serviceName'] = serviceName;

    var url = getOriginUrl(swagger);
    console.error(url);

    writeSpec(url, type, exPatch, function (error, result) {
      if (error)
        return logError(error, result);

      var newFilename = getSwaggerPath(result.swagger);
      if (newFilename !== filename)
        asyncCb(Error("Spec was moved to new location"));
      asyncCb(null);
    });
  }, function (error) {
    if (error)
      throw error;
  });
}

function cacheResources(specRootUrl) {
  _.each(getSpecs(), function (swagger, filename) {
    if (_.isUndefined(swagger.info['x-logo']))
      return;

    var url = swagger.info['x-logo'].url;
    getResource(url, {encoding: null, gzip: true}, function(err, response, data) {
      assert(!err, err);

      var mime = response.headers['content-type'];
      assert(mime.match('image/'));
      var extension = MIME.extension(mime);
      assert(extension);
      var logoFile = 'cache/' + filename.replace(/swagger.json$/, 'logo.' + extension);
      saveFile(logoFile, data);

      var fragment = URI(url).fragment();
      if (fragment)
        fragment = '#' + fragment;

      swagger.info['x-logo'].url = specRootUrl + logoFile + fragment;
      saveJson(filename, swagger);
    });
  });
}

function getResource(url, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }

  options.method = 'GET';
  options.url = url;
  new Request(options, function(err, response, data) {
    if (err)
      return callback(new Error('Can not GET "' + url +'": ' + err));
    if (response.statusCode !== 200)
      return callback(new Error('Can not GET "' + url +'": ' + response.statusMessage));
    console.log(url);
    callback(null, response, data);
  });
}

function generateList() {
  var list = {};

  _.each(getSpecs(), function (swagger, filename) {
    var id = getProviderName(swagger);
    assert(id.indexOf(':') === -1);

    var service = getServiceName(swagger);
    if (!_.isUndefined(service)) {
      assert(service.indexOf(':') === -1);
      id += ':' + service;
    }

    var version = swagger.info.version;
    if (_.isUndefined(list[id]))
      list[id] = { versions: {} };

    list[id].versions[version] = swagger;
  });

  _.each(list, function (api, id) {
    if (_.size(api.versions) === 1)
      api.preferred = _.keys(api.versions)[0];
    else {
      _.each(api.versions, function (spec, version) {
        var preferred = spec.info['x-preferred'];
        assert(_.isBoolean(preferred));
        if (preferred) {
          assert(!api.preferred);
          api.preferred = version;
        }
      });
    }
  });

  return list;
}

function generateAPI(specRootUrl) {
  var list = {};

  _.each(generateList(), function (api, id) {
    var dir = id.replace(/:/, '/');
    list[id] = {
      preferred: api.preferred,
      versions: {}
    };
    _.each(api.versions, function (swagger, version) {
      var filename = dir + '/' + version + '/swagger.json';

      var versionObj = list[id].versions[version] = {
        swaggerUrl: specRootUrl + getSwaggerPath(swagger),
        info: swagger.info,
        added: gitLogDate('--follow --diff-filter=A -1', filename),
        updated: gitLogDate('-1', filename)
      };

      if (swagger.externalDocs)
        versionObj.externalDocs = swagger.externalDocs;
    });
    //FIXME: here we don't track deleted version, not a problem for right now :)
    list[id].added = _(list[id].versions).values().pluck('added').min();
  });

  console.log('Generated list for ' + _.size(list) + ' API specs.');

  saveJson('api/v1/list.json', list);
}

function generateCSV(list) {
  var header = [
    'id',
    'info_title',
    'info_description',
    'info_termsOfService',
    'info_contact_name',
    'info_contact_url',
    'info_contact_email',
    'info_license_name',
    'info_license_url',
    'info_x-website',
    'info_x-logo_url',
    'info_x-logo_background',
    'info_x-apiClientRegistration_url',
    'info_x-pricing_type',
    'info_x-pricing_url',
    'externalDocs_description',
    'externalDocs_url',
  ];

  var table = [header];
  _.forEach(generateList(), function (api, id) {
    var apiData = api.versions[api.preferred];
    var row = [id];
    _.forEach(header, function (column) {
      if (column === 'id') return;

      var path = column.replace(/_/g, '.');
      row.push(_.get(apiData, path));
    });
    table.push(row);
  });

  csvStringify(table, function (err, output) {
    assert(!err, 'Failed stringify: ' + err);
    saveFile('internal_api/list.csv', output);
  });
}

function generateAPIsJSON(specRootUrl) {
  var collection = {
    name: 'APIs.guru',
    description: 'Wikipedia for Web APIs',
    image: 'https://apis-guru.github.io/api-models/branding/logo_horizontal.svg',
    added: '2015-10-15',
    modified: new Date().toISOString().substring(0, 10),
    url: specRootUrl + 'apis.json',
    specificationVersion: '0.15',
    apis: [],
    maintainers: [{
      FN: 'APIs.guru',
      email: 'founders@APIs.guru',
      photo: 'https://apis-guru.github.io/api-models/branding/logo_horizontal.svg'
    }]
  };

  _.each(getSpecs(), function (swagger) {
    var info = swagger.info;
    collection.apis.push({
      name: info.title,
      description: info.description,
      image: info['x-logo'] && info['x-logo'].url,
      humanUrl: swagger.externalDocs && swagger.externalDocs.url,
      baseUrl: swagger.schemes[0] + '://' + swagger.host + swagger.basePath,
      version: info.version,
      properties: [{
        type: 'Swagger',
        url: specRootUrl + getSwaggerPath(swagger)
      }]
    });
  });

  saveJson('apis.json', collection);
}

function gitLogDate(options, filename) {
  var result = exec('git log --format=%aD ' + options + ' -- \'' + filename + '\'');
  result = result.toString();
  return new Date(result);
}

/* TODO: automatic detection of version formats
function compareVersions(ver1, ver2) {
  assert(ver1 !== ver2);

  var versionRegex = /^v(\d+(?:\.\d+)*)(?:beta(\d+))?$/
  var ver1parts = ver1.match(versionRegex);
  var ver2parts = ver2.match(versionRegex);
}
*/

function validateCollection() {
  var specs = getSpecs();
  var foundErrors = false;
  async.forEachOfSeries(specs, function (swagger, filename, asyncCb) {
    console.error('======================== ' + filename + ' ================');
    validateSwagger(swagger, function (errors, warnings) {
      foundErrors = !_.isEmpty(errors) || foundErrors;
      if (errors)
        logJson(errors);
      if (warnings)
        logJson(warnings);
    });
    asyncCb(null);
  }, function () {
    if (foundErrors)
      process.exitCode = errExitCode;
  });
}

function addToCollection(type, url, command) {
  var exPatch = {info: {}};
  if (command.service)
    exPatch.info['x-serviceName'] = command.service;

  writeSpec(url, type, exPatch, function (error, result) {
    if (!error && !command.fixup)
      return;

    if (!command.fixup || !result.swagger)
      return logError(error, result);

    editFile(errorToString(error, result), function (error, data) {
      if (error) {
        console.error(error);
        process.exitCode = errExitCode;
        return;
      }

      var match = data.match(/\?+ Swagger.*$((?:.|\n)*?^}$)/m);
      if (!match || !match[1]) {
        console.error('Can not match edited Swagger');
        process.exitCode = errExitCode;
        return;
      }
      var editedSwagger = JSON.parse(match[1]);
      saveFixup(result.swagger, editedSwagger);
    });
  });
}

function editFile(data, cb) {
  var tmpfile = mktemp('/tmp/XXXXXX.fixup.txt');
  fs.writeFileSync(tmpfile, data);

  editor(tmpfile, function (code) {
    if (code !== 0)
      return cb(Error('Editor closed with code ' + code));

    cb(null, fs.readFileSync(tmpfile, 'utf-8'));
  });
}

function saveFixup(swagger, editedSwagger) {
  var fixupPath = getSwaggerPath(swagger, 'fixup.json');

  //Before diff we need to unpatch, it's a way to appeand changes
  var fixup = readJson(fixupPath);
  if (fixup)
    jsondiffpatch.unpatch(swagger, fixup);

  var diff = jsondiffpatch.diff(swagger, editedSwagger);
  if (diff)
    saveJson(fixupPath, diff);
}

function updateGoogle() {
  var knownSpecs = _.mapKeys(getSpecs(), getOriginUrl);

  getResource('https://www.googleapis.com/discovery/v1/apis', function(err, response, data) {
    assert(!err, err);

    data = JSON.parse(data);
    assert.equal(data.kind, 'discovery#directoryList');
    assert.equal(data.discoveryVersion, 'v1');

    var result = [];
    //FIXME: data.preferred
    _.each(data.items, function (api) {
      //blacklist
      if ([
             //missing API description
             'cloudlatencytest:v2',
             //asterisk in path
             'admin:directory_v1',
             //plus in path
             'pubsub:v1',
             'pubsub:v1beta1',
             'pubsub:v1beta1a',
             'pubsub:v1beta2',
             'genomics:v1',
             'appengine:v1beta4',
             'storagetransfer:v1',
             'cloudbilling:v1',
             'proximitybeacon:v1beta1',
             'youtubereporting:v1',
             //circular reference in MapFolder/MapItem
             'mapsengine:exp2',
             'mapsengine:v1',
           ].indexOf(api.id) >= 0) {
          return;
      }

      assert(typeof api.preferred === 'boolean');
      var addPath = {
        info: {
          'x-preferred': api.preferred
        }
      };

      var url = api.discoveryRestUrl;
      var knownSpec = knownSpecs[url];
      if (!_.isUndefined(knownSpec)) {
        mergePatch(knownSpec, addPath);
        return;
      }

      console.error(url);
      writeSpec(url, 'google', null, function (error, result) {
        if (error)
          return logError(error, result);
        mergePatch(result.swagger, addPath);
      });
    });
  });
}

function mergePatch(swagger, addPatch) {
  var path = getSwaggerPath(swagger, 'patch.json');
  var patch = readJson(path);
  var newPatch = jsonPatch.merge(patch, addPatch);

  if (!_.isEqual(patch, newPatch))
    saveJson(path, newPatch);
}

function writeSpec(source, type, exPatch, callback) {
  converter.getSpec(source, type, function (err, spec) {
    assert(!err, err);

    convertToSwagger(spec, function (error, swagger) {
      var result = {
        spec: spec,
        errors: error
      };

      if (error)
        return callback(error, result);

      patchSwagger(swagger, exPatch);
      result.swagger = swagger;

      function done(errors, warnings) {
        result.warnings = warnings;

        if (errors)
          return callback(errors, result);

        if (warnings)
          logJson(warnings);

        var filename = saveSwagger(swagger);
        callback(null, result);
      }

      function validateAndFix() {
        validateSwagger(swagger, function (errors, warnings) {
          if (!errors)
            return done(errors, warnings);

          if (fixSpec(swagger, errors))
            validateAndFix();
          else
            validateSwagger(swagger, done);
        });
      }

      validateAndFix();
    });
  });
}

function fixSpec(swagger, errors) {
  var fixed = false;

  _.each(errors, function (error) {
    var parentPath = jp.compile(_.dropRight(error.path));
    var path = jp.compile(error.path);

    var parentValue = jp(swagger, parentPath);
    var value = jp(swagger, path);

    var newValue;

    switch(error.code) {
      case 'MISSING_PATH_PARAMETER_DEFINITION':
        var field = error.message.match(': (.+)$')[1];
        newValue = _.clone(value);
        newValue.parameters = value.parameters || [];
        newValue.parameters.push({
          name: field,
          type: 'string',
          in: 'path',
          required: true
        });
        break;
      case 'OBJECT_MISSING_REQUIRED_PROPERTY_DEFINITION':
        newValue = _.clone(value);
        newValue.required = [];
        _.each(value.required, function (name) {
          if (!_.isUndefined(value.properties[name]))
            newValue.required.push(name);
        });
        if (_.isEmpty(newValue.required))
          delete newValue.required;
        break;
      case 'ONE_OF_MISSING':
        if (value.in === 'path' && !value.required) {
          newValue = _.clone(value)
          newValue.required = true;
        }
        break;
      case 'UNRESOLVABLE_REFERENCE':
        if (typeof swagger.definitions[value] !== 'undefined')
          newValue = '#/definitions/' + value;
        break;
      case 'DUPLICATE_OPERATIONID':
        //FIXME: find better solutions than strip all 'operationId'
        jsonPath.apply(swagger, '$.paths[*][*].operationId', function (value) {
          return undefined;
        });
        fixed = true;
        break;
      case 'OBJECT_MISSING_REQUIRED_PROPERTY':
        if (error.message === 'Missing required property: version') {
          newValue = _.clone(value);
          newValue.version = '1.0.0';
          break;
        }
        if (value.type === 'array' && _.isUndefined(value.items)) {
          newValue = _.clone(value);
          newValue.items = {};
        }
        break;
      case 'ENUM_MISMATCH':
      case 'INVALID_FORMAT':
      case 'INVALID_TYPE':
        if (_.last(error.path) !== 'default')
          break;
        var type = parentValue.type;
        if (_.isString(value) && !_.isUndefined(type) && type !== 'string') {
          try {
            newValue = JSON.parse(value);
          }
          catch (e) {}
        }
        delete parentValue.default;
        //TODO: add warning
        break;
    }
    if (!_.isUndefined(newValue)) {
      jp(swagger, path, newValue);
      fixed = true;
    }
  });
  return fixed;
}

function logError(error, context) {
  console.error(errorToString(error, context));
  process.exitCode = errExitCode;
}

function errorToString(errors, context) {
  var spec = context.spec;
  var swagger = context.swagger;
  var warnings = context.warnings;
  var url = spec.source;

  var result = '++++++++++++++++++++++++++ Begin ' + url + ' +++++++++++++++++++++++++\n';
  if (spec.type !== 'swagger_2' || _.isUndefined(swagger)) {
    result += Json2String(spec.spec);
    if (spec.subResources)
      result += Json2String(spec.subResources);
  }

  if (!_.isUndefined(swagger)) {
    result += '???????????????????? Swagger ' + url + ' ????????????????????????????\n';
    result += Json2String(swagger);
  }

  if (errors) {
    result += '!!!!!!!!!!!!!!!!!!!! Errors ' + url + ' !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n';
    if (_.isArray(errors))
      result += Json2String(errors);
    else
      result += errors.stack + '\n';
  }

  if (warnings) {
    result += '******************** Warnings ' + url + ' ******************************\n';
    result += Json2String(warnings);
  }
  result += '------------------------- End ' + url + ' ----------------------------\n';
  return result;
}

function Json2String(json) {
  json = sortobject(json);
  return JSON.stringify(json, null, 2) + '\n';
}

function logJson(json) {
  console.error(Json2String(json));
}

function validateSwagger(swagger, callback) {
  //TODO: remove 'getSpec', instead do it when reading file.
  converter.getSpec(swagger, 'swagger_2', function (err, spec) {
    assert(!err, err);
    spec.validate(callback);
  });
}

function getSpecs(dir) {
  dir = dir || '';
  var files = glob.sync(dir + '**/swagger.json');
  return _.transform(files, function (result, filename) {
    result[filename] = readJson(filename);
  }, {});
}

function patchSwagger(swagger, exPatch) {
  removeEmpty(swagger.info);

  var patch = exPatch;
  var pathComponents = getPathComponents(swagger);

  var path = '';
  _.each(pathComponents, function (dir) {
    path += dir + '/';
    var subPatch = readJson(path + 'patch.json');

    if (!_.isUndefined(subPatch))
      patch = jsonPatch.merge(patch, subPatch);
  });

  //swagger-converter if title is absent use host as default
  if (swagger.info.title === swagger.host && !_.isUndefined(patch.info.title))
    delete swagger.info.title;

  applyMergePatch(swagger, patch);

  var fixup = readJson(getSwaggerPath(swagger, 'fixup.json'));
  swagger = jsondiffpatch.patch(swagger, fixup);
}

function removeEmpty(obj) {
  if (!_.isObject(obj))
    return;

  _.forEach(obj, function (value, key) {
    removeEmpty(value);
    if (value === '' || _.isEmpty(value))
      delete obj[key];
  });
}

function convertToSwagger(spec, callback) {
  spec.convertTo('swagger_2', function (err, swagger) {
    if (err)
      return callback(err);

    _.merge(swagger.spec.info, {
      'x-providerName': parseHost(swagger.spec),
      'x-origin': {
        format: spec.formatName,
        version: spec.getFormatVersion(),
        url: spec.source
      }
    });
    callback(null, swagger.spec)
  });
}

function parseHost(swagger) {
  assert(swagger.host);
  var p = parseDomain(swagger.host);
  p.domain = p.domain.replace(/^www.?/, '')
  p.subdomain = p.subdomain.replace(/^www.?/, '')
  //TODO: use subdomain to detect 'x-serviceName'

  var host = p.tld;
  if (p.domain !== '')
    host = p.domain + '.' + host;

  //Workaround for google API
  if (p.tld === 'googleapis.com')
    host = p.tld;

  assert(host && host !== '');
  return host;
}

function readJson(filename) {
  if (!fs.existsSync(filename))
    return;

  var data = fs.readFileSync(filename, 'utf-8');
  return JSON.parse(data);
}


function getOrigin(swagger) {
  return swagger.info['x-origin'];
}

function getSpecType(swagger) {
  var origin = getOrigin(swagger);
  return converter.getTypeName(origin.format, origin.version);
}

function getOriginUrl(swagger) {
  return getOrigin(swagger).url;
}

function getProviderName(swagger) {
  return swagger.info['x-providerName'];
}

function getServiceName(swagger) {
  return swagger.info['x-serviceName'];
}

function getPathComponents(swagger) {
  var serviceName = getServiceName(swagger);
  var path = [getProviderName(swagger)];
  if (serviceName)
    path.push(serviceName);
  path.push(swagger.info.version);

  return path;
}

function getSwaggerPath(swagger, filename) {
  filename = filename || 'swagger.json';
  return getPathComponents(swagger).join('/') + '/' + filename;
}

function saveJson(path, json) {
  saveFile(path, Json2String(json));
}

function saveFile(path, data) {
  console.log(path);
  mkdirp(Path.dirname(path));
  fs.writeFileSync(path, data);
}

function saveSwagger(swagger) {
  var path = getSwaggerPath(swagger);
  saveJson(path, swagger);
  return path;
}

//code is taken from 'json-merge-patch' package and simplify to allow only adding props
function applyMergePatch(target, patch) {
  assert(_.isPlainObject(target));

  if (patch === null)
    return;

  var keys = Object.keys(patch);
  _.forEach(patch, function (value, key) {
    assert(value !== null, 'Patch tried to delete property: ' + key);

    if (_.isPlainObject(target[key]))
      return applyMergePatch(target[key], value);

    assert(_.isUndefined(target[key]), 'Patch tried to override property: ' + key);
    target[key] = value;
  });
};
