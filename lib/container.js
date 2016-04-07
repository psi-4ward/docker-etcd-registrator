var debug = require('debug')('container');
var _ = require('lodash');

/**
 * Container definition
 * @param {Object} dockerData
 * @constructor
 */
function Container(dockerData) {
  var self = this;
  
  // parse attribs from env-vars
  this.attribs = {common: {}};
  _.forEach(dockerData.env, function(val, key) {
    var m = key.match(/^SERVICE_([0-9]+)?(?:_)?(.*)/);

    if(!m) return;
    var port = m[1] || 'common';
    var attrib = m[2];
    if(!self.attribs[port]) self.attribs[port] = {};
    if(attrib.toLowerCase() === 'tags') val = val.split(',');
    self.attribs[port][attrib] = val;
  });


  this.name = this.attribs['common'].NAME || dockerData.name;
  this.ports = dockerData.ports;
  this.cid = dockerData.id;
  this.image = dockerData.image;
  this.networkMode = dockerData.networkMode;
}


/**
 * Return services
 * @returns {Array} PortServices
 */
Container.prototype.getServices = function() {
  var self = this;

  return _(this.ports)
    .map(function(portCfg) {
      var attribs = self.attribs[portCfg.port] || self.attribs['common'] || {};
      if(attribs.IGNORE) return false;

      var service = {
        name: attribs.NAME || self.name,
        ident: self.hostname + '-' + (attribs.NAME || self.name) + '-' + portCfg.port,
        protocol: portCfg.protocol,
        port: portCfg.port,
        ip: portCfg.containerIP,
        cid: self.cid,
        image: self.image,
        attribs: attribs
      };

      if(process.env.REGISTER === 'public') {
        if(!portCfg.hostPort) {
          debug('Omit container ' + self.cid + ' cause no exposed hostPort');
          return false;
        }
        if(!portCfg.hostIP || portCfg.hostIP === '0.0.0.0' || process.env.FORCE_PUBLIC_IP) {
          if(!process.env.REGISTER_PUBLIC_IP) {
            console.log('Error: Port ' + portCfg.port + ' from ' + self.cid + ' listens on all interface but u did not provide REGISTER_PUBLIC_IP');
            return false;
          }
          if (process.env.FORCE_PUBLIC_IP) {
            debug('Forcing public IP: ' + process.env.REGISTER_PUBLIC_IP);
          }
          service.ip = process.env.REGISTER_PUBLIC_IP;
        } else {
          service.ip = portCfg.hostIP;
        }
        service.port = portCfg.hostPort;
      }

      debug('Service: ' + service.name + '(' + service.ip + ':' + service.port + ')' + ' from ' + service.cid);
      return service;
    })
    .compact()
    .value();
};


module.exports = function containerFactory(data) {
  var s = new Container(data);

  if(s.networkMode !== 'bridge') {
    debug('Omit container ' + s.cid + ' cause --net=host');
    return false;
  }
  if(s.attribs['common'].IGNORE) {
    debug('Omit container ' + s.cid + ' SERVICE_IGNORE');
    return false;
  }

  return s;
};