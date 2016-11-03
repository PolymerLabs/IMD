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

  //// AsyncPromises ////

  const useAsynPromises = true;
  const debugging = {};

  /**
   * Holds an instance of a module and passes it to fulfill require()
   * promises when the define() is called with a module as payload or 
   * a promise that is subsequently fulfilled. 
   * 
   * This class is not intended to interfere with the module-registry
   * and should remain separated from any such logic. Also, to ensure
   * separation of concerns, this class must be driven by a registry 
   * class (ie, Modules) in-order to actively resolve a dependency.
   * 
   * @class Module
   */
  class Module {
    constructor(id, module) {
      Object.assign(this, { id, module });

      /**
       * declarationPromise is a contract for a module that is being required 
       * or defined. It will be fullfilled once the define() method is called 
       * and the definePromise is resolved, the declarationPromise is also 
       * resolved passing the defined module as the only parameter. 
       */
      this.declarationPromise = Object.assign(new Promise((resolve, reject) => {
        Object.assign(this, { resolve, reject });
      }), { domain: 'declarationPromise', intent: 'module:' + this.id });

      // Resolve declaration for self-defining module
      if (module) this.define(module);
    }

    /**
     * When a declared module is being required by calling the appropriate require 
     * function of the module registry, the registry will attempt to call require on
     * the instance to obtain a "declarationPromise" promise that is either resolved 
     * with the module payload or pending till a "definePromise" is fullfilled.
     * 
     * Note: It is assumed that the registry will handle the creation and declaration 
     * aspects of a module and a module shall remain passive for security concerns.
     * 
     * @returns {Promise} declarationPromise or rejected promise
     * 
     * @memberOf Module
     */
    require() {

      // Return the modules one and only declarationPromise when it exists
      if (this.declarationPromise instanceof Promise) return this.declarationPromise;

      // Return a rejected promise if integrity is compromised
      return Object.assign(Promise.reject('Requirement unfulfilled: could not resolve module!'), {
        domain: 'requireReject', intent: 'module:' + this.id, payload: this.module
      });

    }

    /**
     * When a declared module is being defined by calling the appropriate define method 
     * of the module registry, the registry will attempt to call define on the module 
     * instance, passing the dependencies and factory processed from the AMD-style 
     * define call. Dependencies can either be literal module payloads or promises that
     * need to be resolved and passed to the factory method. Once all dependencies have
     * been resolved, this "definePromise" will set the resulting module payload to the
     * instance.module property and resolve the "declarationPromise" passing along the
     * module to all consumers as needed.
     * 
     * Note: It is assumed that the registry will handle the creation and declaration 
     * aspects of a module and a module shall remain passive for security concerns.
     * 
     * @param {any} [dependencies] - Array of module payloads or promises resolved to be passed to factory
     * @param {any} factory - Module factory function
     * @returns
     * 
     * @memberOf Module
     */
    define(dependencies, factory) {
      // Argument shuffling: dependencies = [], factory = Function
      const args = Array.from(arguments);
      dependencies = Array.isArray(args[0]) ? args.shift() : [];
      factory = args.shift();

      if (debugging.define || debugging.Module) console.log('Module:define %s: ', this.id, { dependencies, factory, arguments });

      // Ensure valid state before define proceeds
      if (typeof factory != 'function') throw `Define aborted: Factory is not a function!`;                     // Cannot define a module without factory
      if (this.module) throw `Define blocked: Module has already been defined!`;                                // Cannot redefine module
      if (this.definitionPromise instanceof Promise) throw `Define blocked: Module is already being defined!`;  // Cannot define until pending define promise is not resolved

      // Define and return a payload-specific definitionPromise
      return (this.definitionPromise = Object.assign(new Promise((resolve, reject) => {
        Promise.all(dependencies).then((dependencies) => {
          if (debugging.define || debugging.Module) console.log('Module:define:dependencies %s: %O', this.id, dependencies);

          // Last check to ensure this.module has not been set by chance of error
          if (this.module) {
            if (debugging.define || debugging.Module) console.warn('Module::define::resolve BLOCKED! %s: %o', this.id, { defined: this.module, factory: factory });
            throw `Define blocked: Module has already been defined!`;
          }

          try {
            this.module = Object.assign({}, this.exports, typeof factory != 'function' ? factory : factory.apply(null, dependencies));
            this.resolve(this.module), resolve(this.module);
            if (debugging.define || debugging.Module) console.log('Define success %s: %O', this.id, { module: this, factory, dependencies });
          } catch (exception) {
            // Report failure to fulfill define promise 
            console.error(exception), console.warn(`Define failed: Module promise failed to complete`);

            // Reset state to allow subsequent define payloads for pending dependenants
            this.module = undefined, this.definitionPromise = undefined;

            // Reject "definePromise" (do nothing about "declarationPromise")
            reject(exception);
          }

        });
      }), {
          domain: 'definitionPromise', intent: 'module:' + this.id, payload: this.module
        }));

    }
  }

  /**
   * Basic module registry class which is responsible for handling all Calls
   * to define and require by loaded scripts, when delegated to it by the 
   * respective IMD functions.
   * 
   * This class is responsible for the instantiation, declaration, and 
   * management of all module dependencies. It provides identical define 
   * and register API's to accept delegated calls, then performs all logic 
   * needed to instantiate and declare modules once they are being defined 
   * or required prior to performing the logic that will fullfill either 
   * tasks.
   * 
   * Note: Some functionality has been duplicated from the IMD code to allow
   * for additional control. It's essential to always ensure that changes in
   * are appropriately reflected. Only define method delegation is supported.
   * 
   * TODO:
   * 
   * While the delegate method to define is essential for AMD modules, 
   * require is only needed for node-style require assignments, with a 
   * degree of implied auto-loading of dependencies. Until such a feature 
   * is better defined, this implementation should not be used to delegate
   * require calls from IMD's _require function. That said, there are no 
   * foreseen problems if you opt to do so, but be sure to investigate. 
   * 
   * A key use-case, where a module might be required, but not at all 
   * defined by any other script, will result in a declarationPromise being 
   * indefinitely pending. This use case requires the implementation of a 
   * timeout mechanism that responds to the completion of script loading.
   * 
   * @class Modules
   */
  class Modules {
    constructor() {
      Object.assign(this, { modules: {} }); // new Map()
    }

    /**
     * Internal method, called by define or require, that returns a 
     * declared module instance or create it based on the id.
     * 
     * @param {any} id
     * @returns
     * 
     * @memberOf Modules
     */
    declare(id) {
      return id in this.modules ? this.modules[id] : (this.modules[id] = new Module(id));
    }

    /**
     * Used internally to require dependencies in define calls.
     * 
     * Note: Use as delegate method for IMD's _require not recommended
     * 
     * @param {any} id
     * @returns
     * 
     * @memberOf Modules
     */
    require(id) {
      const module = this.declare(id), payload = module.module, promise = module.require();
      if (debugging.require || debugging.Modules) console.log('Modules::require', { id, module, payload, promise });
      return promise;
    }

    /**
     * Delegate method to be called by IMD's define function.
     * 
     * @param {any} [id]
     * @param {any} [dependencies]
     * @param {any} factory
     * @returns
     * 
     * @memberOf Modules
     */
    define(id, dependencies, factory) {
      const args = Array.from(arguments),
        inferredId = _inferModuleId(), base = inferredId.match(/^(.*?)[^\/]*$/)[1];

      id = (typeof args[0] == 'string') ? args.shift() : inferredId;
      dependencies = (Array.isArray(args[0])) ? args.shift() : [];
      factory = args.shift() || dependencies || id;

      if (debugging.define || debugging.Modules) console.log('Modules::define', { id, dependencies, factory, arguments });

      // Prevent duplicate definition but return reference to existing declaration
      if (id in this.modules) return this.modules[id];

      // Get or create module instance
      const module = this.declare(id);

      // Compose dependency promise
      const dependencyTree = dependencies.map(dependency => {
        if (dependency instanceof Promise) {
          if (debugging.define || debugging.Modules) console.log('\tPreserving dependency promise: ', dependency);
          return dependency;
        }
        if (typeof dependency == 'object') {
          if (debugging.define || debugging.Modules) console.log('\tResolving explicit dependency: ', dependency)
          return dependency;
        }
        if ((/^(exports|require|module)$/).test(dependency)) {
          if (debugging.define || debugging.Modules) console.log('\tResolving internal dependency: %s', dependency)
          if (dependency === 'exports') return Promise.resolve(module.exports = {});
          if (dependency === 'require') return Promise.resolve(_require);
          if (dependency === 'module') return module.define(() => { id });
        }
        if (typeof dependency == 'string') {
          const relativeID = _resolveRelativeId(base, dependency);
          if (debugging.define || debugging.Modules) console.log('\tResolving implicit dependency: ', relativeID, base);
          return this.require(relativeID);
        }
        if (debugging.define || debugging.Modules) console.log('\tResolving unknown dependency: [%s] %O', typeof dependency, dependency);
        return dependency;
      });

      return module.define(dependencyTree, factory);

    }

  }

  //// AsyncPromises ////


  /** @type {Object<key, *>} A mapping of ids to modules. */
  var _modules = /* AsyncPromises */ useAsynPromises === true ? new Modules() : /* AsyncPromises */  Object.create(null);

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
    // Delegate to async-modules if _modules is a Modules instance
    /* AsyncPromises */ if (_modules instanceof Modules) return _modules.define(id, dependencies, factory); /* AsyncPromises */

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
    if (id in _modules) {
      throw new Error('The module "' + id + '" has already been defined');
    }
    // Extract the entire module path up to the file name. Aka `dirname()`.
    //
    // TODO(nevir): This is naive; doesn't support the vulcanize case.
    var base = id.match(/^(.*?)[^\/]*$/)[1];
    if (base === '') {
      base = id;
    }
    _modules[id] = _runFactory(id, base, dependencies, factory);
    return _modules[id];
  }

  // Semi-private. We expose this for tests & introspection.
  define._modules = _modules;

  /**
   * Let other implementations know that this is an AMD implementation.
   * @see https://github.com/amdjs/amdjs-api/wiki/AMD#defineamd-property-
   */
  define.amd = {};

  // Utility

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
   * @param {string} base The base path that modules should be relative to.
   * @param {Array<string>} dependencies
   * @param {function(...*)|*} factory
   */
  function _runFactory(moduleId, base, dependencies, factory) {
    if (typeof factory !== 'function') return factory;

    var exports = {};
    var module = {id: moduleId};
    var modules;

    if (Array.isArray(dependencies)) {
      modules = dependencies.map(function(id) {
        if (id === 'exports') {
          return exports;
        }
        if (id === 'require') {
          return _require;
        }
        if (id === 'module') {
          return module;
        }
        id = _resolveRelativeId(base, id);
        return _require(id);
      });
    } else {
      modules = [_require, exports, module];
    }
    var result = factory.apply(null, modules);
    return result || module.exports || exports;
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
    /* AsyncPromises */
    // !!!! Experimental !!!! Delegation only applies to define
    // // Delegate to async-modules if _modules is a Modules instance
    // if (_modules instanceof Modules) return _modules.require(id);
    /* AsyncPromises */

    if (!(id in _modules)) {
      throw new ReferenceError('The module "' + id + '" has not been loaded');
    }
    return _modules[id];
  }

  // Exports
  scope.define = define;

})(this);
