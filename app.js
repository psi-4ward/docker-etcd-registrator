var _ = require('lodash');
var util = require('util');
var execSync = require('child_process').execSync;
var Docker = require('./lib/Docker');
var fs = require('fs');

/*******************/
/* Config defaults */
/*******************/

_.defaults(process.env, {
  HOSTNAME: execSync('hostname').toString().trim(),

  DOCKER_HOST: 'unix:///var/run/docker.sock',
  //DOCKER_HOST: 'tcp://localhost:2376',
  //DOCKER_TLS_VERIFY
  //DOCKER_CERT_PATH

  //ETCD_ENDPOINTS: 'http://127.0.0.1:4001',
  //ETCD_CAFILE: undefined,
  //ETCD_CERTFILE: undefined,
  //ETCD_KEYFILE: undefined,

  //SKYDNS_ETCD_PREFIX: '/skydns/local/skydns',
  //VULCAND_ETCD_PREFIX: '/vulcand',

  //REGISTER=public,
  //REGISTER_PUBLIC_IP=10.0.1.5
});



/* Docker */
console.log('Starting docker-etcd-registrator');
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
  } else if(err.code === 'EACCES') {
    console.error('Error: Access to ' + process.env.DOCKER_HOST + ' denied!');
    process.exit(2);
  }
  errorLogger('Docker', err);
});


/* Load backends */
var backends = [];
fs.readdirSync(__dirname + '/backends').forEach(function(file) {
  if(!file.match(/\.js$/)) return;
  var Be = require(__dirname + '/backends/' + file);
  backends.push(new Be(docker));
});

// Sync
function sync() {
  console.log('Sync etcd with running containers');
  docker.getRunning(function(err, services) {
    if(err) return errorLogger('sync', err);
    _.invoke(backends, 'sync', services);
  });
}
docker.on('eventstream_open', function() {
  console.log('Docker daemon connected');
  sync();
  setInterval(sync, 3600 * 8 * 1000);
});


function errorLogger(method, err) {
  if(!err) return;
  console.error('Error: ' + method);
  console.error(util.inspect(err, {showHidden: false, depth: 4}));
}

// shutdown
process.on('SIGTERM', function() {
  process.exit(0);
});
process.on('SIGINT', function() {
  process.exit(0);
});

