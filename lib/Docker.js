var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Modem = require('docker-modem');
var debug = require('debug')('docker');
var _ = require('lodash');
var async = require('async');


/**
 * Constructor
 *
 * @emits: eventstream_open, start, die, eventstream_close, error
 *
 * @param {object} opts
 * @returns {Docker}
 * @constructor
 */
function Docker(opts) {
  if(! this instanceof Docker) return new Docker(opts);

  this.Modem = new Modem();
  if(!opts) opts = {};
  if(opts.timeout) this.Modem.timeout = opts.timeout;
  this.maxCidLength = opts.maxCidLength || 16;

  this.opts = opts;

  this._init();

}
util.inherits(Docker, EventEmitter);


/**
 * Init the event-stream
 */
Docker.prototype._init = function init() {
  var self = this;
  debug('Init Docker event listener');

  this.Modem.dial({
    path: '/events',
    method: 'GET',
    isStream: true,
    statusCodes: {
      200: true,
      500: "server error"
    }
  }, function(err, stream) {
    if(err) return self.emit('error', err);

    self.emit('eventstream_open', stream);

    stream
      .on('data', function(buff) {
        var obj = JSON.parse(buff);
        obj.id = obj.id.substr(0, self.maxCidLength);
        switch(obj.status) {
          case 'die':
            debug('Emit "die" event CID:' + obj.id);
            self.emit('die', obj.id);
            break;

          case 'start':
            self.inspect(obj.id, function(err, data) {
              if(err) return self.emit('error', err);
              debug('Emit "start" event CID:' + obj.id);
              self.emit('start', data);
            });
            break;

          default:
            debug('Ignore "' + obj.status + '" event CID:' + obj.id);
        }
      })
      .on('error', function(err) {
        self.emit('error', err);
      })
      .on('close', function() {
        self.emit('eventstream_close')
      });
  });
};


/**
 * Inspect a running container and return the parsed dara
 * @param {string} id
 * @param cb
 */
Docker.prototype.inspect = function inspect(id, cb) {
  var self = this;

  debug('Inspect container ' + id.substr(0, this.maxCidLength));
  this.Modem.dial({
    path: '/containers/' + id + '/json',
    method: 'GET',
    statusCodes: {
      200: true,
      404: "no such container",
      500: "server error"
    }
  }, function(err, obj) {
    if(err) return cb(err);
    cb(null, self._parseInspect(obj));
  });
};


/**
 * Helper method to pick the interesting data from insect-json
 * @param {obj} inspect-data
 * @returns {{id: *, name: string, image: *, ports: Array, env: {}, networkMode: *}}
 */
Docker.prototype._parseInspect = function parseInspect(obj) {
  var data = {
    id: obj.Id.substr(0, this.maxCidLength),
    name: obj.Name.substr(1),
    image: obj.Image,
    ports: [],
    env: {},
    networkMode: obj.HostConfig.NetworkMode
  };

  _.forEach(obj.NetworkSettings.Ports, function(cfg, portProto) {
    var port = {};
    portProto = portProto.split('/');
    port.port = portProto[0];
    port.protocol = portProto[1];
    port.containerIP = obj.NetworkSettings.IPAddress;
    port.hostIP = cfg && cfg[0].HostIp;
    port.hostPort = cfg && cfg[0].HostPort;

    data.ports.push(port);
  });

   obj.Config.Env.forEach(function(val) {
     val = val.split('=');
     data.env[val.shift()] = val.join('=');
  });

  return data;
};


/**
 * Return the parsed data for all running containers
 * @param cb
 */
Docker.prototype.getRunning = function getRunning(cb) {
  var self = this;
  debug('Fetch all running containers');
  this.Modem.dial({
    path: '/containers/json',
    method: 'GET',
    statusCodes: {
      200: true,
      400: "bad parameter",
      500: "server error"
    }
  }, function(err, obj) {
    if(err) return cb(err);
    async.map(
      _.pluck(obj, 'Id'),
      self.inspect.bind(self),
      cb
    );
  });
};

module.exports = Docker;