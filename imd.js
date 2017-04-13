/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
(function(scope) {
  'use strict';

  /** @type {Object<key, *>} A mapping of ids to modules. */
  var _modules = Object.create(null);
  /** @type {Object<key, *>} A mapping of ids to deferral specs */
  var _deferredModules = Object.create(null);
  /** @type {Object<string, string[]>} Modules to a list of its dependencies. */
  var _modulesToTheirDirectDependencies = Object.create(null);
  /** @type {number} The number of modules left to load. */
  var _modulesRemaining = 0;
  var _moduleTimer;

  // `define`

  /**
   * An AMD-compliant implementation of `define` that does not perform loading.
   *
   * @see https://github.com/amdjs/amdjs-api/wiki/AMD
   *
   * Dependencies must be loaded prior to calling `define`, or you will receive
   * an error.
   *
   * @param {string=} id The id of the module being defined. If not provided,
   *     one will be given to the module based on the document it was called in.
   * @param {Array<string>=} dependencies A list of module ids that should be
   *     exposed as dependencies of the module being defined.
   * @param {function(...*)|*} factory A function that is given the exported
   *     values for `dependencies`, in the same order. Alternatively, you can
   *     pass the exported value directly.
   */
  function define(id, dependencies, factory) {
    if (_moduleTimer) {
      clearTimeout(_moduleTimer);
    }
    factory = factory || dependencies || id;
    if (Array.isArray(id)) {
      dependencies = id;
    }
    if (typeof id !== 'string') {
      id = _inferModuleId();
    }
    // TODO(nevir): Just support \ as path separators too. Yay Windows!
    if (id.indexOf('\\') !== -1) {
      throw new TypeError('Please use / as module path delimiters');
    }
    // Extract the entire module path up to the file name. Aka `dirname()`.
    //
    // TODO(nevir): This is naive; doesn't support the vulcanize case.
    var base = id.match(/^(.*?)[^\/]*$/)[1];
    if (base === '') {
      base = id;
    }
    _runDefine(id, base, dependencies, factory);
    if (_modulesRemaining) {
      _moduleTimer = setTimeout(function () {
        var errorMessage = '';
        for (var dependency in _modulesToTheirDirectDependencies) {
          if (errorMessage) errorMessage += ', ';
          errorMessage  += '"' + dependency + '" (required by [' +
            _modulesToTheirDirectDependencies[dependency]
              .map(function (name) {return '"' + name + '"';})
              .join(', ') +
            '])';
        }
        throw Error('Required modules were not loaded before the timeout: ' +
                    errorMessage);
      }, define._timeout);
    }
  }

  // Semi-private. We expose this for tests & introspection.
  define._modules = _modules;
  // Semi-private. We expose this for tests & introspection.
  define._timeout = 9000;

  /**
   * Let other implementations know that this is an AMD implementation.
   * @see https://github.com/amdjs/amdjs-api/wiki/AMD#defineamd-property-
   */
  define.amd = {};


  // Utility

  /**
   * Calls `factory` with the exported values of `dependencies`, or defers
   * the call for later if any of its dependencies are not defined yet.
   *
   * @param {string} id The id of the module defined by the factory.
   * @param {string} base The base path that modules should be relative to.
   * @param {Array<string>} dependencies
   * @param {function(...*)|*} factory
   */
  function _runDefine(id, base, dependencies, factory) {
    var absoluteDependencies = _makeDependenciesAbsolute(base, dependencies);
    var modules = new Array(absoluteDependencies.length);
    var unresolvedDependencyCount = 0;
    var exports = {};
    var module = {id: id};
    absoluteDependencies.forEach(function (dependencyName, ix) {
      if (dependencyName === 'exports') {
        modules[ix] = exports;
      } else if (dependencyName === 'require') {
        modules[ix] = _require;
      } else if (dependencyName === 'module') {
        modules[ix] = module;
      } else if (dependencyName in _modules) {
        modules[ix] = _modules[dependencyName];
      } else {
        unresolvedDependencyCount++;
        (_modulesToTheirDirectDependencies[dependencyName] =
          _modulesToTheirDirectDependencies[dependencyName] || []).push(id);
      }
    });
    if (unresolvedDependencyCount == 0) {
      _runFactory(id, modules, factory, module, exports);
    } else {
      _modulesRemaining++;
      _deferredModules[id] = {
        dependencies: absoluteDependencies,
        unresolvedDependencyCount: unresolvedDependencyCount,
        modules: modules,
        module: module,
        exports: exports,
        id: id,
        factory: factory
      };
    }
  }

  /** @return {string} A module id inferred from the current document/import. */
  function _inferModuleId() {
    var script = document._currentScript || document.currentScript;
    if (script && script.hasAttribute('as')) {
      return script.getAttribute('as');
    }

    var doc = script && script.ownerDocument || document;
    if (!doc.baseURI) {
      throw new Error('Unable to determine a module id: No baseURI for the document');
    }

    if (script && script.hasAttribute('src')) {
      return new URL(script.getAttribute('src'), doc.baseURI).toString();
    }

    return doc.baseURI;
  }

  /**
   * Calls `factory` with the exported values of `dependencies`.
   *
   * @param {string} id The id of the module defined by the factory.
   * @param {Array<*>} modules
   * @param {function(...*)|*} factory
   */
  function _runFactory(moduleId, modules, factory, module, exports) {
    if (moduleId in _modules) {
      throw new Error('The module "' + moduleId + '" has already been defined');
    }
    if (typeof factory !== 'function') {
      _modules[moduleId] = factory;
    } else {
      var result = factory.apply(null, modules);
      _modules[moduleId] = (result || module.exports || exports);
    }
    _flushDependencies(moduleId);
  }

  function _flushDependencies(id) {
    (_modulesToTheirDirectDependencies[id] || []).forEach(function (dependentName) {
      var dependencySpec = _deferredModules[dependentName];
      var thisDependencyIndex = dependencySpec.dependencies.indexOf(id);
      dependencySpec.modules[thisDependencyIndex] = _modules[id];
      if (dependencySpec.unresolvedDependencyCount == 0) {
        throw new Error('The module "' + id +
            '" says it has already been completed, but one of its ' +
            'dependencies had not been resolved');
      }
      if (--dependencySpec.unresolvedDependencyCount == 0) {
        delete _deferredModules[dependentName];
        _runFactory(dependencySpec.id, dependencySpec.modules,
                    dependencySpec.factory, dependencySpec.module,
                    dependencySpec.exports);
        _modulesRemaining--;
      }
    });
    delete _modulesToTheirDirectDependencies[id];
  }

  /**
   * Get a list of dependencies without loading them yet
   * @param {string} base The base path that modules should be relative to.
   * @param {Array<string>} dependencies
   * @return {Array<string>} the resolved absolute dependencies
   */
  function _makeDependenciesAbsolute(base, dependencies) {
    if (!Array.isArray(dependencies)) {
      return ['require', 'exports', 'module'];
    }
    return dependencies.map(function (id) {
      return _resolveRelativeId(base, id);
    });
  }

  /**
   * Resolve `id` relative to `base`
   *
   * @param {string} base The module path/URI that acts as the relative base.
   * @param {string} id The module ID that should be relatively resolved.
   * @return {string} The expanded module ID.
   */
  function _resolveRelativeId(base, id) {
    if (id[0] !== '.') return id;
    // TODO(justinfagnani): use URL
    // We need to be careful to only process the path of URLs. This regex
    // strips off the URL protocol and domain, leaving us with just the URL's
    // path.
    var match  = base.match(/^([^\/]*\/\/[^\/]+\/)?(.*?)\/?$/);
    var prefix = match[1] || '';
    // We start with the base, and then mutate it into the final path.
    var terms   = match[2] ? match[2].split('/') : [];
    // Split the terms, ignoring any leading or trailing path separators.
    var idTerms = id.match(/^\/?(.*?)\/?$/)[1].split('/');
    for (var i = 0; i < idTerms.length; i++) {
      var idTerm = idTerms[i];
      if (idTerm === '.') {
        continue;
      } else if (idTerm === '..') {
        terms.pop();
      } else {
        terms.push(idTerm);
      }
    }
    return prefix + terms.join('/');
  }

  function _require(id) {
    if (!(id in _modules)) {
      throw new ReferenceError('The module "' + id + '" has not been loaded');
    }
    return _modules[id];
  }

  // Exports
  scope.define = define;

})(this);
