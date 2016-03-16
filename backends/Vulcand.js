var util = require('util');
var _ = require('lodash');
var debug = require('debug')('vulcand');
var etcd = require('../lib/etcd.js');
var async = require('async');
var backendMixin = require('../lib/backendMixin.js');


/**
 * Create a new Vulcand backend
 * @constructor
 */
function Vulcand(docker) {
  if(!this instanceof Vulcand) return new Vulcand(docker);

  this.name = "Vulcand";
  this.prefix = process.env.VULCAND_ETCD_PREFIX || '/vulcand';
  this.cidCache = {};
  this.docker = docker;
  this.debug = debug;
  this.etcd = etcd;
  this.removeDepthWhenEmpty = 2;  

  this.defaults = {
    BE: {
      Type: "http",
      Settings: {}
    },
    FE: {
      Type: "http",
      BackendId: undefined,
      Route: undefined,
      Settings: {}
    }
  };

  this.docker.on('newService', this.addService.bind(this));
  this.docker.on('die', this.removeServiceByCid.bind(this));
  console.log('Vulcand etcd path: ' + this.prefix);
}
_.merge(Vulcand.prototype, backendMixin);


/**
 * Transfor env attribs object into json
 * @param {String} type
 * @param {Object} attribs
 * @returns {Object} {*}
 */
Vulcand.prototype.attribs2json = function env2json(type, attribs) {
  if(!this.defaults[type]) throw new Error('Undefined type, use: ' + Object.keys(this.defaults).join(', '));
  var obj = _.cloneDeep(this.defaults[type]);

  _.forEach(attribs, function(val, name) {
    if(name.substr(0, 11) !== 'VULCAND_' + type + '_') return;
    name = name.substr(11);
    var keys = name.split('_');
    var curr = obj;

    keys.forEach(function(key, i) {
      if(i >= keys.length-1) {
        val = val === 'true' || (val === 'false' ? false : val);
      } else {
        if(!curr[key]) curr[key] = {};
        curr = curr[key];
      }
    });
  });

  return obj;
};

/**
 * Add a vulcand backend and frontend by service
 * @param {Object} service
 * @param cb
 */
Vulcand.prototype.addService = function addService(service, cb) {
  async.parallel([
    this.addBackend.bind(this, service),
    this.addFrontend.bind(this, service)
  ], cb)
};


Vulcand.prototype._buildBeServerUrl = function _buildBeServerUrl(service) {
  if(_.some(service.attribs, function(v, k) {
      return k.substr(0, 10) === 'VULCAND_BE';
    })) {
    return this.prefix + '/backends/' + service.name + '/servers/' + this._getIdent(service);
  }

  debug('Ignore backend ' + service.name + ':' + service.port + ' no VULCAND_BE attribs');
  return false;

};


Vulcand.prototype._buildFeCatalogUrl = function _buildFeCatalogUrl(service) {
  if(_.some(service.attribs, function(v, k) {
      return k.substr(0, 10) === 'VULCAND_FE';
    })) {
    return this.prefix + '/frontends/' + service.name + '/registrator-catalog/' + this._getIdent(service);
  }

  debug('Ignore frondent ' + service.name + ':' + service.port + ' no VULCAND_FE attribs');
  return false;
};


/**
 * Add a vulcand backend by service
 * @param {Object} service
 * @param cb
 */
Vulcand.prototype.addBackend = function addBackend(service, cb) {
  var self = this;

  var srvUrl = this._buildBeServerUrl(service);
  if(srvUrl === false) return cb();
  var url = this.prefix + '/backends/' +  service.name;
  var BEdata = this.attribs2json('BE', service.attribs);

  console.log('Vulcand Backend: ' + service.name + ' ' + service.ip + ':' + service.port + ' [' + url + ']');
  etcd.set(url + '/backend', JSON.stringify(BEdata), function(err) {
    if(err) return cb(err);

    // Add Server
    var SRVdata = {URL: BEdata.Type + '://' + service.ip + ':' + service.port};
    etcd.set(
      srvUrl,
      JSON.stringify(SRVdata),
      function(err) {
        if(err) return cb(err);
        if(!self.cidCache[service.cid]) self.cidCache[service.cid] = [];
        self.cidCache[service.cid].push(srvUrl);
        cb();
      }
    );
  });
};


  /**
 * Add a vulcand frontend by service
 * @param {Object} service
 * @param cb
 */
Vulcand.prototype.addFrontend = function addFrontend(service, cb) {
  var self = this;

  var catalogURL = this._buildFeCatalogUrl(service);
  if(catalogURL === false) return cb();

  var url = this.prefix + '/frontends/' +  service.name;
  var FEdata = this.attribs2json('FE', service.attribs);
  if(!FEdata.BackendId) FEdata.BackendId = service.name;

  // register catalog item
  // used to find out if we can remove the frontend
  console.log('Vulcand Frontend: ' + service.name  + ' Route:' + FEdata.Route + ' [' + url + ']');
  etcd.set(catalogURL, '1', function(err) {
    if(err) return cb(err);
    if(!self.cidCache[service.cid]) self.cidCache[service.cid] = [];
    self.cidCache[service.cid].push(catalogURL);

    // register frontend
    etcd.set(
      url + '/frontend',
      JSON.stringify(FEdata),
      cb
    );
  });
};


Vulcand.prototype._getIdent = function _getIdent(service) {
  return process.env.HOSTNAME + '-' + service.cid + '-' + service.port;
};


/**
 * Sync the etcd-services to the given
 * @param {Object} activeServicesByPort
 */
Vulcand.prototype.sync = function (activeServicesByPort, cb) {
  var self = this;

  var runningMap = {};
  activeServicesByPort.forEach(function(service) {
    var feUrl = self._buildFeCatalogUrl(service);
    if(feUrl) runningMap[feUrl] = service;
    var beUrl = self._buildBeServerUrl(service);
    if(beUrl) runningMap[beUrl] = service;
  });

  // Fetch current etcd-services
  etcd.get(this.prefix, {recursive: true}, function(err, obj) {
    if(err) {
      console.error('Error: etcd get ' + self.prefix);
      console.error(util.inspect(err, {showHidden: false, depth: 4}));
      return;
    }

    // recursive find keys beginning with our HOSTNAME
    var inEtcdUrls = [];
    if(obj.node.nodes) {
      inEtcdUrls = etcd.deepFindKeys(obj.node, new RegExp('/' + process.env.HOSTNAME + '-[^/]*'));
    }

    var runningUrls = _.keys(runningMap);

    // remove not running
    function removeObsolete(cb) {
      var toDelete = _.difference(inEtcdUrls, runningUrls);
      if(toDelete.length == 0) return cb();
      debug('Remove ' + toDelete.length + ' obsolete services');
      self.removeByUrls(toDelete, cb);
    }

    // add not registred
    function addRunning(cb) {
      var toAdd = _.difference(runningUrls, inEtcdUrls);
      toAdd = _(toAdd)
        .map(function(url) {
          return runningMap[url];
        })
        .unique()
        .value();
      if(toAdd.length == 0) return cb();

      debug('Adding ' + toAdd.length + ' already running services');
      async.eachLimit(toAdd, 10, function(serviceByPort, next) {
        self.addService(serviceByPort, function() {
          if(err) return console.error('Error: Could add service ' + err.error.cause + ': ' + err.error.message);
          next();
        });
      }, cb);
    }

    async.series([addRunning, removeObsolete], cb);
  });

};


module.exports = Vulcand;
