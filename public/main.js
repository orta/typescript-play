// whoa, no typescript and no compilation!

globalThis.typeDefs = {}

const LibManager = {
  libs: {},

  coreLibPath: `https://unpkg.com/typescript@${window.CONFIG.TSVersion}/lib/`,

  getReferencePaths(input) {
    const rx = /<reference path="([^"]+)"\s\/>/;
    return (input.match(new RegExp(rx.source, "g")) || []).map(s => {
      const match = s.match(rx);
      if (match && match.length >= 2) {
        return match[1];
      } else {
        throw new Error(`Error parsing: "${s}".`);
      }
    });
  },

  basename(url) {
    const parts = url.split("/");
    if (parts.length === 0) {
      throw new Error(`Bad url: "${url}"`);
    }
    return parts[parts.length - 1];
  },

  addLib: async function(path, ...args) {
    if (path.indexOf("http") === 0) {
      return this._addRemoteLib(path, ...args);
    }
    return this._addCoreLib(path, ...args);
  },

  _addCoreLib: async function(fileName, ...args) {
    return this._addRemoteLib(`${this.coreLibPath}${fileName}`, ...args);
  },

  _addRemoteLib: async function(url, stripNoDefaultLib = true, followReferences = true) {
    const fileName = this.basename(url);

    if (this.libs[fileName]) {
      return;
    }

    UI.toggleSpinner(true);
    const res = await fetch(url);
    if (res.status === 404) {
      console.log(`Check https://unpkg.com/typescript@${window.CONFIG.TSVersion}/lib/`);
    }
    const rawText = await res.text();

    UI.toggleSpinner(false);

    const text = stripNoDefaultLib ? rawText.replace('/// <reference no-default-lib="true"/>', "") : rawText;

    if (followReferences) {
      const paths = this.getReferencePaths(text);
      if (paths.length > 0) {
        console.log(`${fileName} depends on ${paths.join(", ")}`);
        for (const path of paths) {
          await this._addCoreLib(path, stripNoDefaultLib, followReferences);
        }
      }
    }

    const lib = monaco.languages.typescript.typescriptDefaults.addExtraLib(text, fileName);

    console.groupCollapsed(`Added '${fileName}'`);
    console.log(text);
    console.groupEnd();

    this.libs[fileName] = lib;

    return lib;
  },

  acquireModuleMetadata: {},

  /**
   * @param {string} sourceCode 
   */
  detectNewImportsToAcquireTypeFor: async function(sourceCode) {

   /**
   * @param {string} sourceCode 
   * @param {string | undefined} mod 
   * @param {string | undefined} path 
   */
    const getTypeDependenciesForSourceCode = async (sourceCode, mod, path) => {
      // TODO: debounce
      //
      // TODO: This needs to be replaced by the AST - it still works in comments 
      // blocked by https://github.com/microsoft/monaco-typescript/pull/38
      //
      // https://regex101.com/r/Jxa3KX/4
      const requirePattern = /(const|let|var)(.|\n)*? require\(('|")(.*)('|")\);?$/
      //  https://regex101.com/r/hdEpzO/4
      const es6Pattern = /(import|export)((?!from)(?!require)(.|\n))*?(from|require\()\s?('|")(.*)('|")\)?;?$/gm
  
      const foundModules = new Set()
      
      while ((match = es6Pattern.exec(sourceCode)) !== null) {
        if (match[6]) foundModules.add(match[6])
      }
  
      while ((match = requirePattern.exec(sourceCode)) !== null) {
        if (match[5]) foundModules.add(match[5])
      }
      
      const moduleJSONURL = (name) => `http://ofcncog2cu-dsn.algolia.net/1/indexes/npm-search/${name}?attributes=types&x-algolia-agent=Algolia%20for%20vanilla%20JavaScript%20(lite)%203.27.1&x-algolia-application-id=OFCNCOG2CU&x-algolia-api-key=f54e21fa3a2a0160595bb058179bfb1e`
      const unpkgURL = (name, path) => `https://www.unpkg.com/${encodeURIComponent(name)}/${encodeURIComponent(path)}`
      const packageJSONURL = (name) => unpkgURL(name, "package.json")
      const errorMsg = (msg, response) => { console.error(`${msg} - will not try again in this session`, response.status, response.statusText, response); debugger }

      const addLibraryToRuntime = (code, path) => {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(code, path);
        globalThis.typeDefs[path] = code
        console.log(`Adding ${path} to runtime`)
      }

      const getReferenceDependencies = async (sourceCode, mod, path) => {
        if (sourceCode.indexOf("reference path") > 0) {
          // https://regex101.com/r/DaOegw/1
          const referencePathExtractionPattern = /<reference path="(.*)" \/>/gm;
          while ((match = referencePathExtractionPattern.exec(sourceCode)) !== null) {
            const relativePath = match[1];
            if (relativePath) {
              let newPath = mapRelativePath(mod, relativePath, path);
              if (newPath) {
                const dtsRefURL = unpkgURL(mod, newPath);
                const dtsReferenceResponse = await fetch(dtsRefURL);
                if (!dtsReferenceResponse.ok) {
                  return errorMsg(
                    `Could not get ${newPath} for a reference link in the module '${mod}' from ${path}`,
                    dtsReferenceResponse
                  );
                }

                let dtsReferenceResponseText = await dtsReferenceResponse.text();
                if (!dtsReferenceResponseText) {
                  return errorMsg(
                    `Could not get ${newPath} for a reference link for the module '${mod}' from ${path}`,
                    dtsReferenceResponse
                  );
                }

                await getTypeDependenciesForSourceCode(dtsReferenceResponseText, mod, newPath);
                const representationalPath = `node_modules/${mod}/${newPath}`;
                addLibraryToRuntime(dtsReferenceResponseText, representationalPath);
              }
            }
          }
        }
      };


      /**
       * Takes an initial module and the path for the root of the typings and grab it and start grabbing its 
       * dependencies then add those the to runtime.
       *
       * @param {string} mod The module name
       * @param {string} path  The path to the root def type
       */
      const addModuleToRuntime =  async (mod, path) => {
        const isDeno = path && path.indexOf("https://") === 0

        const dtsFileURL = isDeno ? path : unpkgURL(mod, path)
        const dtsResponse = await fetch(dtsFileURL)
        if (!dtsResponse.ok) { return errorMsg(`Could not get root d.ts file for the module '${mod}' at ${path}`, dtsResponse) }

        // TODO: handle checking for a resolve to index.d.ts whens someone imports the folder
        let content = await dtsResponse.text()
        if (!content) { return errorMsg(`Could not get root d.ts file for the module '${mod}' at ${path}`, dtsResponse) }

        // Now look and grab dependent modules where you need the 
        // 
        await getTypeDependenciesForSourceCode(content, mod, path)

        if(isDeno) {
          const wrapped = `declare module "${path}" { ${content} }`
          addLibraryToRuntime(wrapped, path)
        } else {
          const typelessModule = mod.split("@types/").slice(-1)
          const wrapped = `declare module "${typelessModule}" { ${content} }`
          addLibraryToRuntime(wrapped, `node_modules/${mod}/${path}`)
        }
      }

        

        /**
         * Takes a module import, then uses both the algolia API and the the package.json to derive 
         * the root type def path.
         * 
         * @param {string} packageName 
         * @returns {Promise<{ mod: string, path: string, packageJSON: any }>} 
         */
      const getModuleAndRootDefTypePath = async (packageName) => {

        // For modules
        const url = moduleJSONURL(packageName)
        
        const response = await fetch(url)
        if (!response.ok) { return errorMsg(`Could not get Algolia JSON for the module '${packageName}'`,  response) }
        
        const responseJSON = await response.json()
        if (!responseJSON) { return errorMsg(`Could not get Algolia JSON for the module '${packageName}'`, response) }
  
        if (!responseJSON.types) { return console.log(`There were no types for '${packageName}' - will not try again in this session`)  }
        if (!responseJSON.types.ts) { return console.log(`There were no types for '${packageName}' - will not try again in this session`)  }
  
        this.acquireModuleMetadata[packageName] = responseJSON
        
        if (responseJSON.types.ts === "included") {
          const modPackageURL = packageJSONURL(packageName)
  
          const response = await fetch(modPackageURL)
          if (!response.ok) { return errorMsg(`Could not get Package JSON for the module '${packageName}'`, response) }
  
          const responseJSON = await response.json()
          if (!responseJSON) { return errorMsg(`Could not get Package JSON for the module '${packageName}'`, response) }
  
          // Get the path of the root d.ts file
  
          // non-inferred route
          let rootTypePath = responseJSON.typing
          
          // package main is custom 
          if (!rootTypePath && typeof responseJSON.main === 'string' && responseJSON.main.indexOf('.js') > 0) {
            rootTypePath = responseJSON.main.replace(/js$/, 'd.ts');
          }
  
          // Final fallback, to have got here it must have passed in algolia
          if (!rootTypePath) {
            rootTypePath = "index.d.ts"
          }
  
          return { mod: packageName, path: rootTypePath, packageJSON: responseJSON }
        } else if(responseJSON.types.ts === "definitely-typed") {
          return { mod: responseJSON.types.definitelyTyped, path: "index.d.ts", packageJSON: responseJSON }
        } else {
          throw "This shouldn't happen"
        }
      }

      const mapModuleNameToModule = (name) => {
        // in node repl:
        // > require("module").builtinModules
        const builtInNodeMods = ["assert", "async_hooks", "base", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "globals", "http", "http2", "https", "index", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib"]
        if (builtInNodeMods.includes(name)) {
          return "node"
        }
        return name
      }

      //** A really dumb version of path.resolve */
      const mapRelativePath = (outerModule, moduleDeclaration, currentPath) => {
        // https://stackoverflow.com/questions/14780350/convert-relative-path-to-absolute-using-javascript
        function absolute(base, relative) {
          if(!base) return relative

          const stack = base.split("/")
          const parts = relative.split("/");
          stack.pop(); // remove current file name (or empty string)

          for (var i = 0; i < parts.length; i++) {
              if (parts[i] == ".") continue;
              if (parts[i] == "..") stack.pop();
              else stack.push(parts[i]);
          }
          return stack.join("/");
        }

        return absolute(currentPath, moduleDeclaration)
      }

      const convertToModuleReferenceID = (outerModule, moduleDeclaration, currentPath) => {
        const modIsScopedPackageOnly = moduleDeclaration.indexOf("@") === 0 && moduleDeclaration.split("/").length === 2
        const modIsPackageOnly = moduleDeclaration.indexOf("@") === -1 && moduleDeclaration.split("/").length === 1
        const isPackageRootImport = modIsPackageOnly || modIsScopedPackageOnly
        
        if (isPackageRootImport) {
          return moduleDeclaration
        } else {
          return  `${outerModule}-${mapRelativePath(outerModule, moduleDeclaration, currentPath)}` 
        }
      }


      /** @type {string[]} */
      const filteredModulesToLookAt =  Array.from(foundModules)
      // console.log(filteredModulesToLookAt) // , mod, path)
      


      filteredModulesToLookAt.forEach(async name => {
        // Support grabbing the hard-coded node modules if needed
        const moduleToDownload = mapModuleNameToModule(name)

        if (!mod && moduleToDownload.startsWith(".") ) {
          return console.log("Can't resolve local relative dependencies")
        }

        const moduleID = convertToModuleReferenceID(mod, moduleToDownload, path)
        if (this.acquireModuleMetadata[moduleID] || this.acquireModuleMetadata[moduleID] === null) {
          return 
        } 

        const modIsScopedPackageOnly = moduleToDownload.indexOf("@") === 0 && moduleToDownload.split("/").length === 2
        const modIsPackageOnly = moduleToDownload.indexOf("@") === -1 && moduleToDownload.split("/").length === 1
        const isPackageRootImport = modIsPackageOnly || modIsScopedPackageOnly
        const isDenoModule = moduleToDownload.indexOf("https://") === 0

        if (isPackageRootImport) {
          // So it doesn't run twice for a package
          this.acquireModuleMetadata[moduleID] = null

          // E.g. import danger from "danger"
          const packageDef = await getModuleAndRootDefTypePath(moduleToDownload)
        
          if (packageDef) {
            this.acquireModuleMetadata[moduleID] = packageDef.packageJSON
            await addModuleToRuntime(packageDef.mod, packageDef.path)
          }
        } else if (isDenoModule) {
          // E.g. import { serve } from "https://deno.land/std@v0.12/http/server.ts";
          await addModuleToRuntime(moduleToDownload, moduleToDownload)
        } else {
          // E.g. import {Component} from "./MyThing"
          if (!moduleToDownload || !path) throw `No outer module or path for a relative import: ${moduleToDownload}`
          
          const absolutePathForModule = mapRelativePath(mod, moduleToDownload, path)
          // So it doesn't run twice for a package
          this.acquireModuleMetadata[moduleID] = null
          const resolvedFilepath = absolutePathForModule.endsWith(".ts") ? absolutePathForModule : absolutePathForModule + ".d.ts"
          await addModuleToRuntime(mod, resolvedFilepath)
        }
      })
      getReferenceDependencies(sourceCode, mod, path)
    }

    // Start diving into the root 
    getTypeDependenciesForSourceCode(sourceCode, undefined, undefined)
  }
};

async function main() {
  const defaultCompilerOptions = {
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,

    alwaysStrict: true,
    allowUnreachableCode: false,
    allowUnusedLabels: false,

    downlevelIteration: false,
    noEmitHelpers: false,
    noLib: false,
    noStrictGenericChecks: false,
    noUnusedLocals: false,
    noUnusedParameters: false,

    esModuleInterop: false,
    preserveConstEnums: false,
    removeComments: false,
    skipLibCheck: false,

    experimentalDecorators: false,
    emitDecoratorMetadata: false,

    target: monaco.languages.typescript.ScriptTarget.ES2017,
    jsx: monaco.languages.typescript.JsxEmit.None,
  };

  const urlDefaults = Object.entries(defaultCompilerOptions).reduce(
    (acc, [key, value]) => {
      if (params.has(key)) {
        const urlValue = params.get(key);

        if (urlValue === "true") {
          acc[key] = true;
        } else if (urlValue === "false") {
          acc[key] = false;
        } else if (!isNaN(parseInt(urlValue, 10))) {
          acc[key] = parseInt(params.get(key), 10);
        }
      }

      return acc;
    },
    {},
  );

  console.log("Url defaults", urlDefaults);

  const compilerOptions = Object.assign(
    {},
    defaultCompilerOptions,
    urlDefaults,
  );

  const sharedEditorOptions = {
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
  };

  const State = {
    inputModel: null,
    outputModel: null,
  };

  let inputEditor, outputEditor;

  function createSelect(obj, globalPath, title, compilerOption) {
    return `<label class="select">
    <span class="select-label">${title}</span>
  <select onchange="console.log(event.target.value); UI.updateCompileOptions('${compilerOption}', ${globalPath}[event.target.value]);">
  ${Object.keys(obj)
    .filter(key => isNaN(Number(key)))
    .map(key => {
      if (key === "Latest") {
        // hide Latest
        return "";
      }

      const isSelected = obj[key] === compilerOptions[compilerOption];

      return `<option ${
        isSelected ? "selected" : ""
      } value="${key}">${key}</option>`;
    })}
  </select>
  </label>`;
  }

  function createFile(compilerOptions) {
    return monaco.Uri.file(
      "input." +
      (compilerOptions.jsx === monaco.languages.typescript.JsxEmit.None
        ? "ts"
        : "tsx")
    )
  }

  window.UI = {
    tooltips: {},

    shouldUpdateHash: false,

    showFlashMessage(message) {
      const node = document.querySelector(".flash");
      const messageNode = node.querySelector(".flash__message");

      messageNode.textContent = message;

      node.classList.toggle("flash--hidden", false);
      setTimeout(() => {
        node.classList.toggle("flash--hidden", true);
      }, 1000);
    },

    fetchTooltips: async function() {
      try {
        this.toggleSpinner(true);
        const res = await fetch(`${window.CONFIG.baseUrl}schema/tsconfig.json`);
        if(!res.ok) return

        const json = await res.json();
        this.toggleSpinner(false);

        for (const [propertyName, property] of Object.entries(
          json.definitions.compilerOptionsDefinition.properties.compilerOptions
            .properties,
        )) {
          this.tooltips[propertyName] = property.description;
        }
      } catch (e) {
        console.error(e);
        // not critical
      }
    },

    renderAvailableVersions() {
      const node = document.querySelector("#version-popup");
      const html = `
    <ul class="versions">
    ${Object.keys(window.CONFIG.availableTSVersions)
      .sort()
      .reverse()
      .map(version => {
        return `<li class="button" onclick="javascript:UI.selectVersion('${version}');">${version}</li>`;
      })
      .join("\n")}
    </ul>
    `;

      node.innerHTML = html;
    },

    renderVersion() {
      const node = document.querySelector("#version");
      const childNode = node.querySelector("#version-current");

      childNode.textContent = `${window.CONFIG.TSVersion}`;

      node.style.opacity = 1;
      node.classList.toggle("popup-on-hover", true);

      this.toggleSpinner(false);
    },

    toggleSpinner(shouldShow) {
      document
        .querySelector(".spinner")
        .classList.toggle("spinner--hidden", !shouldShow);
    },

    renderSettings() {
      const node = document.querySelector("#settings-popup");

      const html = `
      ${createSelect(
        monaco.languages.typescript.ScriptTarget,
        "monaco.languages.typescript.ScriptTarget",
        "Target",
        "target",
      )}
      <br />
      ${createSelect(
        monaco.languages.typescript.JsxEmit,
        "monaco.languages.typescript.JsxEmit",
        "JSX",
        "jsx",
      )}
    <ul style="margin-top: 1em;">
    ${Object.entries(compilerOptions)
      .filter(([_, value]) => typeof value === "boolean")
      .map(([key, value]) => {
        return `<li style="margin: 0; padding: 0;" title="${UI.tooltips[key] ||
          ""}"><label class="button" style="user-select: none; display: block;"><input class="pointer" onchange="javascript:UI.updateCompileOptions(event.target.name, event.target.checked);" name="${key}" type="checkbox" ${
          value ? "checked" : ""
        }></input>${key}</label></li>`;
      })
      .join("\n")}
    </ul>
    <p style="margin-left: 0.5em; margin-top: 1em;">
      <a href="https://www.typescriptlang.org/docs/handbook/compiler-options.html" target="_blank">
        Compiler options reference
      </a>
    </p>
    `;

      node.innerHTML = html;
    },

    console() {
      if (!window.ts) {
        return;
      }

      console.log(`Using TypeScript ${window.ts.version}`);

      console.log("Available globals:");
      console.log("\twindow.ts", window.ts);
      console.log("\twindow.client", window.client);
    },

    selectVersion(version) {
      if (version === window.CONFIG.getLatestVersion()) {
        location.href = `${window.CONFIG.baseUrl}${location.hash}`;
        return false;
      }

      location.href = `${window.CONFIG.baseUrl}?ts=${version}${location.hash}`;
      return false;
    },

    selectExample: async function(exampleName) {
      try {
        const res = await fetch(`./examples/${exampleName}.ts`,);
        const code = await res.text();
        UI.shouldUpdateHash = false;
        State.inputModel.setValue(code.trim());
        location.hash = `example/${exampleName}`;
        UI.shouldUpdateHash = true;
      } catch (e) {
        console.log(e);
      }
    },

    setCodeFromHash: async function() {
      if (location.hash.startsWith("#example")) {
        const exampleName = location.hash.replace("#example/", "").trim();
        UI.selectExample(exampleName);
      }
    },

    refreshOutput() {
      UI.shouldUpdateHash = false;
      State.inputModel.setValue(State.inputModel.getValue());
      UI.shouldUpdateHash = true;
    },

    updateURL() {
      const diff = Object.entries(defaultCompilerOptions).reduce(
        (acc, [key, value]) => {
          if (value !== compilerOptions[key]) {
            acc[key] = compilerOptions[key];
          }

          return acc;
        },
        {},
      );

      const hash = `code/${LZString.compressToEncodedURIComponent(
        State.inputModel.getValue(),
      )}`;
        
      const urlParams = Object.assign({}, diff);

      ["lib", "ts"].forEach(param => {
        if (params.has(param)) {
          urlParams[param] = params.get(param);
        }
      });

      if (Object.keys(urlParams).length > 0) {
        const queryString = Object.entries(urlParams)
          .map(([key, value]) => {
            return `${key}=${encodeURIComponent(value)}`;
          })
          .join("&");

        window.history.replaceState(
          {},
          "",
          `${window.CONFIG.baseUrl}?${queryString}#${hash}`,
        );
      } else {
        window.history.replaceState({}, "", `${window.CONFIG.baseUrl}#${hash}`);
      }
    },

    storeCurrentCodeInLocalStorage() {
      localStorage.setItem("playground-history", State.inputModel.getValue())
    },

    updateCompileOptions(name, value) {
      console.log(`${name} = ${value}`);

      Object.assign(compilerOptions, {
        [name]: value,
      });

      console.log("Updating compiler options to", compilerOptions);
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
        compilerOptions,
      );

      let inputCode = inputEditor.getValue();
      State.inputModel.dispose();
      State.inputModel = monaco.editor.createModel(
        inputCode,
        "typescript",
        createFile(compilerOptions)
      );
      inputEditor.setModel(State.inputModel);

      UI.refreshOutput();

      UI.renderSettings();

      UI.updateURL();
    },

    getInitialCode() {
      if (location.hash.startsWith("#src")) {
        const code = location.hash.replace("#src=", "").trim();
        return decodeURIComponent(code);
      }
      
      if (location.hash.startsWith("#code")) {
        const code = location.hash.replace("#code/", "").trim();
        return LZString.decompressFromEncodedURIComponent(code);
      }

      if (localStorage.getItem("playground-history")) {
        return localStorage.getItem("playground-history")
      }

      return `
const message: string = 'hello world';
console.log(message);
  `.trim();
    },
  };

  window.MonacoEnvironment = {
    getWorkerUrl: function(workerId, label) {
      return `worker.js?version=${window.CONFIG.getMonacoVersion()}`;
    },
  };

  for (const path of window.CONFIG.extraLibs) {
    await LibManager.addLib(path);
  }

  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
    compilerOptions,
  );

  State.inputModel = monaco.editor.createModel(
    UI.getInitialCode(),
    "typescript",
    createFile(compilerOptions)
  );

  State.outputModel = monaco.editor.createModel(
    "",
    "javascript",
    monaco.Uri.file("output.js"),
  );

  inputEditor = monaco.editor.create(
    document.getElementById("input"),
    Object.assign({ model: State.inputModel }, sharedEditorOptions),
  );

  outputEditor = monaco.editor.create(
    document.getElementById("output"),
    Object.assign({ model: State.outputModel }, sharedEditorOptions),
  );

  function updateOutput() {
    monaco.languages.typescript.getTypeScriptWorker().then(worker => {
      worker(State.inputModel.uri).then((client, a) => {
        if (typeof window.client === "undefined") {
          UI.renderVersion();

          // expose global
          window.client = client;
          UI.console();
        }
        
        const userInput = State.inputModel
        const sourceCode =  userInput.getValue()
        LibManager.detectNewImportsToAcquireTypeFor(sourceCode)

        client.getEmitOutput(userInput.uri.toString()).then(result => {
          State.outputModel.setValue(result.outputFiles[0].text);
        });
      });
    });

    if (UI.shouldUpdateHash) {
      UI.updateURL();
    }

    UI.storeCurrentCodeInLocalStorage()
  }

  UI.setCodeFromHash();

  UI.renderSettings();
  UI.fetchTooltips().then(() => {
    UI.renderSettings();
  });

  updateOutput();
  inputEditor.onDidChangeModelContent(() => {
    updateOutput();
  });
  UI.shouldUpdateHash = true;

  UI.renderAvailableVersions();

  /* Run */
  document.getElementById("run").onclick = () => runJavaScript()
  function runJavaScript() {
    console.clear();
    // to hide the stack trace
    setTimeout(() => {
      eval(State.outputModel.getValue());
    }, 0);
  }

  inputEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    runJavaScript,
  );

  outputEditor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    runJavaScript,
  );

  inputEditor.addCommand(
    monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KEY_F,
    prettier,
  );

  // if the focus is outside the editor
  window.addEventListener(
    "keydown",
    event => {
      const S_KEY = 83;
      if (event.keyCode == S_KEY && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();

        window.clipboard.writeText(location.href.toString()).then(
          () => UI.showFlashMessage("URL is copied to the clipboard!"),
          e => {
            alert(e);
          },
        );
      }

      if (
        event.keyCode === 13 &&
        (event.metaKey || event.ctrlKey) &&
        event.target instanceof Node &&
        event.target === document.body
      ) {
        event.preventDefault();
        runJavaScript();
      }
    },
    false,
  );

  function prettier() {
    const PRETTIER_VERSION = "1.14.3";

    require([
      `https://unpkg.com/prettier@${PRETTIER_VERSION}/standalone.js`,
      `https://unpkg.com/prettier@${PRETTIER_VERSION}/parser-typescript.js`,
    ], function(prettier, { parsers }) {
      const cursorOffset = State.inputModel.getOffsetAt(
        inputEditor.getPosition(),
      );

      const formatResult = prettier.formatWithCursor(
        State.inputModel.getValue(),
        {
          parser: parsers.typescript.parse,
          cursorOffset,
        },
      );

      State.inputModel.setValue(formatResult.formatted);
      const newPosition = State.inputModel.getPositionAt(
        formatResult.cursorOffset,
      );
      inputEditor.setPosition(newPosition);
    });
  }
}
