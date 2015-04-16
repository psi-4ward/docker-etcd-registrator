fs = require('fs');
var _ = require('lodash');
Etcd = require('node-etcd');

var endpoints = [];
var sslopts = false;
if(!process.env.ETCD_ENDPOINTS) {
  endpoints.push('127.0.0.1:4001');
} else {
  var ssl = false;
  endpoints = process.env.ETCD_ENDPOINTS.split(',').map(function(ep) {

    if(ep.substr(0,8) === 'https://') ssl = true;
    return ep.replace(/^https?:\/\//, '', ep);
  });

  if(ssl) {
    sslopts = {
      ca: fs.readFileSync(process.env.ETCD_CAFILE),
      cert: fs.readFileSync(process.env.ETCD_CERTFILE),
      key: fs.readFileSync(process.env.ETCD_KEYFILE),
      securityOptions: 'SSL_OP_NO_SSLv3'
    };
  }
}

var etcd = new Etcd(endpoints,  sslopts);

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

module.exports = etcd;
