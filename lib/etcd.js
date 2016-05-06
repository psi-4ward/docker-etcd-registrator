fs = require('fs');
var _ = require('lodash');
Etcd = require('node-etcd');

var WAIT_TIME = 200;
var MAX_TRIES = 3;
var BACKOFF = 2;

var endpoints = [];
if(!process.env.ETCD_ENDPOINTS) {
  endpoints.push('127.0.0.1:4001');
} else {
  var ssl = false;
  endpoints = process.env.ETCD_ENDPOINTS.split(',').map(function(ep) {

    if(ep.substr(0,8) === 'https://') ssl = true;
    return ep.replace(/^https?:\/\//, '', ep);
  });

  if(ssl) {
    var sslopts = {
      ca: fs.readFileSync(process.env.ETCD_CAFILE),
      cert: fs.readFileSync(process.env.ETCD_CERTFILE),
      key: fs.readFileSync(process.env.ETCD_KEYFILE),
      securityOptions: 'SSL_OP_NO_SSLv3'
    };
  }
}

console.log('Etcd peers:', process.env.ETCD_ENDPOINTS);

if (ssl)
  var etcd = new Etcd(endpoints,  sslopts);
else
  var etcd = new Etcd(endpoints);

// mixin some useful methods
function deepFindKeys(node, regexp) {
  var hits = [];
  if(regexp.test(node.key)) {
    hits.push(node.key);
    return hits;
  }
  if(node.nodes && _.isArray(node.nodes)) {
    node.nodes.forEach(function(node) {
      hits = hits.concat(deepFindKeys(node, regexp));
    });
  }
  return hits;
}
etcd.deepFindKeys = deepFindKeys;

// add retry behaviour
var orgFuncs = {
  del: etcd.del,
  set: etcd.set
};

function retry() {
  var tries = 0;
  var args = _.slice(arguments);
  var func = args.shift();
  var cb = args.pop();
  if(typeof cb !== 'Function') {
    args.push(cb);
    cb = function(){};
  }

  args.push(function(err, data) {
    if(!err) return cb(err, data);
    if(err && errorCode < 500) return cb(err, data);
    if(tries >= MAX_TRIES) return cb(err, data);

    setTimeout(function() {
      console.log('Retry', 'etcd.'+func, args[0]);
      tries++;
      orgFuncs[func].apply(etcd, args);
    }, Math.round(WAIT_TIME * Math.pow(BACKOFF,tries)) );
  });

  orgFuncs[func].apply(etcd, args);
}

etcd.del = retry.bind(etcd, 'del');
etcd.set = retry.bind(etcd, 'set');


module.exports = etcd;
