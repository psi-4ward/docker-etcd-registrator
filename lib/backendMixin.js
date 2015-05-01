var _ = require('lodash');
var async = require('async');
var path = require('path');

module.exports = {

  /**
   * Remove a service by container id
   * @param {String} cid
   */
  removeServiceByCid: function removeServiceByCid(cid) {
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
  },


  /**
   * Remove services by etcd-keys
   * @param {Array} urls
   * @param cb
   */
  removeByUrls: function removeByUrls(urls, cb) {
    var self = this;
    var possiblyEmptyDir = [];

    function removeUrls(cb) {
      async.eachLimit(urls, 5, function(url, next) {
        console.log(self.name + ' Remove: ' + url);
        self.etcd.del(url, function(err) {
          if(err) return console.error('Error: Could not delete ' + err.error.cause + ': ' + err.error.message);
          possiblyEmptyDir.push(url);
          next();
        });
      }, cb);
    }

    function removeEmptyFolders(cb) {
      if(!self.removeDepthWhenEmpty || self.removeDepthWhenEmpty <= 0) return cb();

      var directories = {};
      _.forEach(possiblyEmptyDir, function(dir) {
        dir = path.dirname(dir);
        var toTest = dir;
        for(var i=1; i<self.removeDepthWhenEmpty; i++) dir = path.dirname(dir);
        directories[toTest] = dir;
      });

      async.eachLimit(_.pairs(directories), 5, function(data, next) {
        self.etcd.get(data[0], function(err, node) {
          if(err && err.errorCode === 100) return next();
          if(err) {
            console.error('Error: Could get ' + err.error.cause + ': ' + err.error.message);
            return next();
          }
          if(!(node && node.node && node.node.nodes && node.node.nodes.length > 0)) {
            self.debug(data[0] + ' is empty, removing ' + data[1]);
            self.etcd.del(data[1], {recursive: true}, function(err) {
              if(err) return console.error('Error: Could not delete ' + err.error.cause + ': ' + err.error.message);
              next();
            });
          }
        });
      }, cb);
    }

    async.series([removeUrls, removeEmptyFolders], cb);
  },


  /**
   * Find all services matching a given container-id
   * @param {String} cid
   * @param cb
   */
  findUrlsByCid: function(cid, cb) {
    var self = this;
    this.etcd.get(this.prefix, {recursive: true}, function(err, obj) {
      if(err) return cb(err);
      if(!obj.node.nodes) return;

      cb(null, self.etcd.deepFindKeys(obj.node, new RegExp('-' + cid + '-')));
    });
  }
};