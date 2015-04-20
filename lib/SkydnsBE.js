var util = require('util');
var _ = require('lodash');
var debug = require('debug')('skydns');
var etcd = require('./etcd.js');


/**
 * Create a new Skydns backend
 * @constructor
 */
function SkydnsBE() {
  this.prefix = process.env.SKYDNS_ETCD_PREFIX || '/skydns/local/skydns';
  this.cidCache = {};
}


/**
 * Add a DNS by portService
 * @param {Object} portService
 * @param cb
 */
SkydnsBE.prototype.addService = function addService(portService, cb) {
  var self = this;
  var url = this._buildUrl(portService);

  var text = portService.protocol;
  if(_.isArray(portService.attribs.TAGS)) text += ',' + portService.attribs.TAGS.join(',');

  var val = {
    host: portService.ip,
    port: parseInt(portService.port, 10),
    priority: portService.attribs.SKYDNS_PRIORITY || 1,
    weight: portService.attribs.SKYDNS_WEIGHT || 1,
    text: text
  };

  debug('Add service: ' + url + ' => ' + portService.ip + ':' + portService.port);
  etcd.set(url, JSON.stringify(val), function(err) {
    if(err) return cb(err);
    if(!self.cidCache[portService.cid]) self.cidCache[portService.cid] = [];
    self.cidCache[portService.cid].push(url);
    cb();
  });
};


/**
 * Remove a service by container id
 * @param {String} cid
 */
SkydnsBE.prototype.removeServiceByCid = function removeServiceByCid(cid) {
  var self = this;
  var urls = this.cidCache[cid];
  if(urls) {
    this.removeByUrls(urls);
    delete this.cidCache[cid];
  } else {
    // cid not in cache, search it
    this.findUrlsByCid(cid, function(err, urls) {
      if(err) return console.error('Could fetch keys ' + err.error.cause + ': ' + err.error.message);
      self.removeByUrls(urls);
    });
  }
};


/**
 * Remove services by etcd-keys
 * @param {Array} urls
 */
SkydnsBE.prototype.removeByUrls = function removeByUrls(urls) {
  urls.forEach(function(url) {
    debug('Remove service: ' + url);
    etcd.del(url, function(err) {
      if(err && err.error) return console.error('Error: Could not delete ' + err.error.cause + ': ' + err.error.message);
      else if(err)  return console.error(util.inspect(err, {showHidden: false, depth: 3}));
    });
  });
  // TODO: remove empty directory also ???
};


/**
 * Sync the etcd-services to the given
 * @param {Object} activeServicesByPort
 */
SkydnsBE.prototype.sync = function (activeServicesByPort) {
  var self = this;

  var runningMap = {};
  activeServicesByPort.forEach(function(portService) {
     runningMap[self._buildUrl(portService)] = portService;
  });

  // Fetch current etcd-services
  etcd.get(this.prefix, {recursive: true}, function(err, obj) {
    if(err) {
      console.error('Error: etcd get ' + self.prefix);
      console.error(util.inspect(err, {showHidden: false, depth: 3}));
      return;
    }

    // recursive find keys beginning with our HOSTNAME
    var inEtcdUrls = [];
    if(obj.node.nodes) {
      inEtcdUrls = etcd.deepFindKeys(obj.node, new RegExp('/' + process.env.HOSTNAME + '-[^/]*'));
    }

    // remove not running
    var runningUrls = _.keys(runningMap);
    var toDelete = _.difference(inEtcdUrls, runningUrls);
    if(toDelete.length) {
      debug('Remove ' + toDelete.length + ' obsolete services');
      self.removeByUrls(toDelete);
    }

    // add not registred
    var toAdd = _.difference(runningUrls, inEtcdUrls);
    if(toAdd.length) {
      debug('Adding ' + toAdd.length + ' already running services');
      toAdd.forEach(function(url) {
        self.addService(runningMap[url], function(err) {
          if(err) return console.error('Error: Could add service ' + err.error.cause + ': ' + err.error.message);
        });
      });
    }
  });

};


/**
 * Find all services matching a given container-id
 * @param {String} cid
 * @param cb
 */
SkydnsBE.prototype.findUrlsByCid = function(cid, cb) {
  etcd.get(this.prefix, {recursive:true}, function(err, obj) {
    if(err) return cb(err);
    if(!obj.node.nodes) return;

    cb(null, etcd.deepFindKeys(obj.node, new RegExp('-'+cid+'-')));
  });
};


SkydnsBE.prototype._buildUrl = function _buildUrl(portService) {
  return this.prefix + '/' + portService.name + '/' + process.env.HOSTNAME + '-' + portService.cid + '-' + portService.port;
};


module.exports = SkydnsBE;