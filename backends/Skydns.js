var util = require('util');
var _ = require('lodash');
var debug = require('debug')('skydns');
var etcd = require('../lib/etcd.js');
var backendMixin = require('../lib/backendMixin.js');


/**
 * Create a new Skydns backend
 * @constructor
 */
function Skydns(docker) {
  if(! this instanceof Skydns) return new Skydns(docker);

  this.name = "SkyDNS";
  this.prefix = process.env.SKYDNS_ETCD_PREFIX || '/skydns/local/skydns';
  this.cidCache = {};
  this.docker = docker;
  this.debug = debug;
  this.etcd = etcd;
  this.removeDepthWhenEmpty = 1;
  
  this.docker.on('newService', this.addService.bind(this));
  this.docker.on('die', this.removeServiceByCid.bind(this));

  console.log('Skydns etcd path: ' + this.prefix);
}
_.merge(Skydns.prototype, backendMixin);


/**
 * Add a DNS by service
 * @param {Object} service
 * @param cb
 */
Skydns.prototype.addService = function addService(service, cb) {
  var self = this;
  var url = this._buildUrl(service);

  var text = service.protocol;
  if(_.isArray(service.attribs.TAGS)) text += ',' + service.attribs.TAGS.join(',');

  var val = {
    host: service.ip,
    port: service.port,
    priority: service.attribs.SKYDNS_PRIORITY || 1,
    weight: service.attribs.SKYDNS_WEIGHT || 1,
    text: text
  };

  console.log('SkyDNS Service: ' + service.name + ' ' + service.ip + ':' + service.port + ' [' + url + ']');
  etcd.set(url, JSON.stringify(val), function(err) {
    if(err) {
      if(cb) cb(err);
      return;
    }
    if(!self.cidCache[service.cid]) self.cidCache[service.cid] = [];
    self.cidCache[service.cid].push(url);
    if(cb) cb();
  });
};


/**
 * Sync the etcd-services to the given
 * @param {Object} activeServices
 */
Skydns.prototype.sync = function (activeServices) {
  var self = this;

  var runningMap = {};
  activeServices.forEach(function(service) {
     runningMap[self._buildUrl(service)] = service;
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


Skydns.prototype._buildUrl = function _buildUrl(service) {
  return this.prefix + '/' + service.name + '/' + process.env.HOSTNAME + '-' + service.cid + '-' + service.port;
};


module.exports = Skydns;