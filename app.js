var _ = require('lodash');
var util = require('util');
var execSync = require('child_process').execSync;
var serviceFactory = require('./lib/service');
var Docker = require('./lib/Docker');
var SkydnsBE = require('./lib/SkydnsBE');

/*******************/
/* Config defaults */
/*******************/

_.defaults(process.env, {
  HOSTNAME: execSync('hostname').toString().trim(),

  //DOCKER_HOST: '/var/run/docker.sock',
  //DOCKER_HOST: 'tcp://localhost:2376',
  //DOCKER_TLS_VERIFY
  //DOCKER_CERT_PATH

  //ETCD_ENDPOINTS: 'http://127.0.0.1:4001',
  //ETCD_CAFILE: undefined,
  //ETCD_CERTFILE: undefined,
  //ETCD_KEYFILE: undefined,

  //SKYDNS_ETCD_PREFIX: '/skydns/local/skydns'
});


/**********/
/* Docker */
/**********/

var docker = new Docker();

// Docker socket gone?
docker.on('eventstream_close', function() {
  console.error('Error: Lost connection to docker daemon');
  process.exit(2);
});

// Error speaking with docker daemon
docker.on('error', function(err) {
  if(err.code === 'ECONNREFUSED') {
    console.error('Error: Connection to ' + process.env.DOCKER_HOST + ' refused!');
    process.exit(2);
  }
  console.error(util.inspect(err, {showHidden: false, depth: 4}));
});


/**********/
/* SkyDNS */
/**********/

var skydnsBE = new SkydnsBE();

function err(method, err) {
  if(!err) return;
  console.error('Error: ' + method);
  console.error(util.inspect(err, {showHidden: false, depth: 4}));
}

// Docker started a container
docker.on('start', function(data) {
  var service = serviceFactory(data);
  if(!service) return;

  service.byPorts().forEach(function(portService) {
    skydnsBE.addService(portService, err.bind('addService'));
  });
});

// A container died (kill, crash, stop, ...)
docker.on('die', function(cid) {
  skydnsBE.removeServiceByCid(cid);
});

// Remove services which dont have running containers
// Add services for container already running
docker.getRunning(function(err, data) {
  var portServices = _(data)
    .map(serviceFactory)
    .compact()
    .invoke('byPorts')
    .flatten()
    .value();

  skydnsBE.sync(portServices);
});