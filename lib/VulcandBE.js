var util = require('util');
var _ = require('lodash');
var debug = require('debug')('vulcand');
var etcd = require('./etcd.js');
var async = require('async');

/**
 * Create a new Vulcand backend
 * @constructor
 */
function VulcandBE() {
  this.prefix = process.env.VULCAND_ETCD_PREFIX || '/vulcand';
  this.cidCache = {};

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
  }
}

/**
 * Transfor env attribs object into json
 * @param {String} type
 * @param {Object} attribs
 * @returns {Object} {*}
 */
VulcandBE.prototype.attribs2json = function env2json(type, attribs) {
  if(!this.defaults[type]) throw new Error('Undefined type, use: ' + Object.keys(this.defaults).join(', '));
  var obj = _.cloneDeep(this.defaults[type]);

  _.forEach(attribs, function(val, name) {
    if(name.substr(0, 11) !== 'VULCAND_' + type + '_') return;
    name = name.substr(11);
    var keys = name.split('_');
    var curr = obj;

    keys.forEach(function(key, i) {
      if(i >= keys.length-1) {
        curr[key] = val;
      } else {
        if(!curr[key]) curr[key] = {};
        curr = curr[key];
      }
    });
  });

  return obj;
};

/**
 * Add a vulcand backend and frontend by portService
 * @param {Object} portService
 * @param cb
 */
VulcandBE.prototype.addService = function addService(portService, cb) {
  async.parallel([
    this.addBackend.bind(this, portService),
    this.addFrontend.bind(this, portService)
  ], cb)
};


VulcandBE.prototype._buildBeServerUrl = function _buildBeServerUrl(portService) {
  if(_.some(portService.attribs, function(v, k) {
      return k.substr(0, 10) === 'VULCAND_BE';
    })) {
    return this.prefix + '/backends/' + portService.name + '/servers/' + this._getIdent(portService);
  }

  debug('Ignore backend ' + portService.name + ':' + portService.port + ' no VULCAND_BE attribs');
  return false;

};


VulcandBE.prototype._buildFeCatalogUrl = function _buildFeCatalogUrl(portService) {
  if(_.some(portService.attribs, function(v, k) {
      return k.substr(0, 10) === 'VULCAND_FE';
    })) {
    return this.prefix + '/frontends/' + portService.name + '/registrator-catalog/' + this._getIdent(portService);
  }

  debug('Ignore frondent ' + portService.name + ':' + portService.port + ' no VULCAND_FE attribs');
  return false;
};


/**
 * Add a vulcand backend by portService
 * @param {Object} portService
 * @param cb
 */
VulcandBE.prototype.addBackend = function addBackend(portService, cb) {
  var self = this;

  var srvUrl = this._buildBeServerUrl(portService);
  if(srvUrl === false) return cb();
  var url = this.prefix + '/backends/' +  portService.name;
  var BEdata = this.attribs2json('BE', portService.attribs);

  debug('Add backend: ' + url + ' => ' + portService.ip + ':' + portService.port);
  etcd.set(url + '/backend', JSON.stringify(BEdata), function(err) {
    if(err) return cb(err);

    // Add Server
    var SRVdata = {URL: BEdata.Type + '://' + portService.ip + ':' + portService.port};
    etcd.set(
      srvUrl,
      JSON.stringify(SRVdata),
      function(err) {
        if(err) return cb(err);
        if(!self.cidCache[portService.cid]) self.cidCache[portService.cid] = [];
        self.cidCache[portService.cid].push(srvUrl);
        cb();
      }
    );
  });
};


  /**
 * Add a vulcand frontend by portService
 * @param {Object} portService
 * @param cb
 */
VulcandBE.prototype.addFrontend = function addFrontend(portService, cb) {
  var self = this;

  var catalogURL = this._buildFeCatalogUrl(portService);
  if(catalogURL === false) return cb();

  var url = this.prefix + '/frontends/' +  portService.name;
  var FEdata = this.attribs2json('FE', portService.attribs);
  if(!FEdata.BackendId) FEdata.BackendId = portService.name;

  // register catalog item
  // used to find out if we can remove the frontend
  debug('Add frontend: ' + url);
  etcd.set(catalogURL, '1', function(err) {
    if(err) return cb(err);
    if(!self.cidCache[portService.cid]) self.cidCache[portService.cid] = [];
    self.cidCache[portService.cid].push(catalogURL);

    // register frontend
    etcd.set(
      url + '/frontend',
      JSON.stringify(FEdata),
      cb
    );
  });
};


VulcandBE.prototype._getIdent = function _getIdent(portService) {
  return process.env.HOSTNAME + '-' + portService.cid + '-' + portService.port;
};


/**
 * Remove a service by container id
 * @param {String} cid
 */
VulcandBE.prototype.removeServiceByCid = function removeServiceByCid(cid, cb) {
  var self = this;
  var urls = this.cidCache[cid];
  if(urls) {
    this.removeByUrls(urls, cb);
    delete this.cidCache[cid];
  } else {
    // cid not in cache, search it
    this.findUrlsByCid(cid, function(err, urls) {
      if(err) return console.error('Could fetch keys ' + err.error.cause + ': ' + err.error.message);
      self.removeByUrls(urls, cb);
    });
  }
};


/**
 * Remove services by etcd-keys
 * @param {Array} urls
 */
VulcandBE.prototype.removeByUrls = function removeByUrls(urls, cb) {

  var possiblyEmpty = {};

  function removeUrls(cb) {
    async.eachLimit(urls, 5, function(url, next) {

      // /backends/<NAME>/servers/<hostname>-<cid>-<port>
      // /frontends/<NAME>/registrator-catalog/<hostname>-<cid>-<port>

      var urlParts = url.split('/').reverse();
      urlParts.shift();
      var type = urlParts.shift();
      var urlBase = urlParts.reverse().join('/');

      debug('Remove: ' + url);
      etcd.del(url, function(err) {
        if(err) return console.error('Error: Could not delete ' + err.error.cause + ': ' + err.error.message);
        possiblyEmpty[urlBase + '/' + type] = urlBase;
        next();
      });
    }, cb);
  }

  function removeEmptyFolders(cb) {
    async.eachLimit(_.pairs(possiblyEmpty), 5, function(data, next) {
      etcd.get(data[0], function(err, node) {
        if(err && err.errorCode === 100) return next();
        if(err) {
          console.error('Error: Could get ' + err.error.cause + ': ' + err.error.message);
          return next();
        }
        if(!(node && node.node && node.node.nodes && node.node.nodes.length > 0)) {
          debug(data[0] + ' is empty, removing ' + data[1]);
          etcd.del(data[1], {recursive: true}, function(err) {
            if(err) return console.error('Error: Could not delete ' + err.error.cause + ': ' + err.error.message);
            next();
          });
        }
      });
    }, cb);
  }
  async.series([removeUrls, removeEmptyFolders], cb);
};


/**
 * Sync the etcd-services to the given
 * @param {Object} activeServicesByPort
 */
VulcandBE.prototype.sync = function (activeServicesByPort, cb) {
  var self = this;

  var runningMap = {};
  activeServicesByPort.forEach(function(portService) {
    var feUrl = self._buildFeCatalogUrl(portService);
    if(feUrl) runningMap[feUrl] = portService;
    var beUrl = self._buildBeServerUrl(portService);
    if(beUrl) runningMap[beUrl] = portService;
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


/**
 * Find all services matching a given container-id
 * @param {String} cid
 * @param cb
 */
VulcandBE.prototype.findUrlsByCid = function(cid, cb) {
  etcd.get(this.prefix, {recursive:true}, function(err, obj) {
    if(err) return cb(err);
    if(!obj.node.nodes) return;

    cb(null, etcd.deepFindKeys(obj.node, new RegExp('-'+cid+'-')));
  });
};




module.exports = VulcandBE;