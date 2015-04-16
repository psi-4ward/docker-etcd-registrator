var debug = require('debug')('service');
var _ = require('lodash');

/**
 * Service definition
 * @param {obj} dockerData
 * @constructor
 */
function Service(dockerData) {
  var self = this;

  // parse attribs from env-vars
  this.attribs = {common: {}};
  _.forEach(dockerData.env, function(val, key) {
    var m = key.match(/^SERVICE_([0-9]+_)?(.*)/);
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
 * Return the service splitted by ports
 * @returns {array} PortServices
 */
Service.prototype.byPorts = function() {
  var self = this;

  return _(this.ports)
    .map(function(portCfg) {
      var attribs = self.attribs[portCfg.port];
      if(attribs.IGNORE) return false;

      return {
        name: attribs.NAME || self.name,
        ident: self.hostname + '-' + (attribs.NAME || self.name) + '-' + portCfg.port,
        protocol: portCfg.protocol,
        port: portCfg.port, // TODO: any logic to use the HostIP?
        ip: portCfg.containerIP, // TODO: any logic to use the HostIP?
        cid: self.cid,
        image: self.image,
        attribs: attribs || self.attribs['common'] || {}
      }
    })
    .compact()
    .value();
};


module.exports = function serviceFactory(data) {
  var s = new Service(data);

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