import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {PRODUCT_UI_PLUGIN_PACKAGE_NAMES} from '../apps/native-server/src/product-plugin-manifest.mjs';
const require=createRequire(pathToFileURL(process.env.APPDATA+'/accr-ui-harness/profile/profiles/web/cordis.yml'));
for(const name of PRODUCT_UI_PLUGIN_PACKAGE_NAMES){const manifest=JSON.parse(readFileSync(require.resolve(name+'/package.json'),'utf8'));assert.equal(manifest.name,name);assert.equal(manifest.dsh.client.platform,'web');}
console.log(`PASS: ${PRODUCT_UI_PLUGIN_PACKAGE_NAMES.length} product client manifests resolvable`);
