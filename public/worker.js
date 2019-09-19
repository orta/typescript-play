const params = new URLSearchParams(location.search);
const version = params.get("version");
const editorModule = params.get("editorModule");

if (!version) {
  throw new Error(`Pass ?version= to worker.js.`);
}

if (!editorModule) {
  throw new Error(`Pass ?editorModule= to worker.js.`);
}

self.MonacoEnvironment = { baseUrl: `https://unpkg.com/${editorModule}@${version}/min` };
importScripts(`https://unpkg.com/${editorModule}@${version}/min/vs/base/worker/workerMain.js`);
