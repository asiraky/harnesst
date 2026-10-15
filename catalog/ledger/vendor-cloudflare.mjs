// Refresh from an explicitly checked-out upstream revision; no implicit network or version bumps.
import { cp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const source=process.argv[2];if(!source)throw Error('Usage: node catalog/ledger/vendor-cloudflare.mjs /path/to/cloudflare/skills-checkout');
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const bundle=JSON.parse(await readFile('catalog/templates/bundles/cloudflare-bundle/template.json'));
for(const entry of bundle.includes.filter(x=>!['building-cloudflare-apps','deploying-cloudflare-apps'].includes(x.id))){
 const root=`catalog/templates/skills/${entry.id}`,dest=`${root}/files/skills/${entry.id}`;
 await rm(dest,{recursive:true,force:true});await cp(path.join(source,'skills',entry.id),dest,{recursive:true});await cp(path.join(source,'LICENSE'),`${dest}/LICENSE`);
 await writeFile(`${dest}/VENDORED.md`,`# Upstream\n\nSource: https://github.com/cloudflare/skills\nCommit: ${commit}\nLicense: Apache-2.0 (LICENSE).\n\nRe-sync with catalog/ledger/vendor-cloudflare.mjs; preserve the harnesst credential note. Bump changed skill versions and cloudflare-bundle, then regenerate and validate the index.\n`);
 if(entry.id==='wrangler'){const f=`${dest}/SKILL.md`;await writeFile(f,(await readFile(f,'utf8')).replace('# Wrangler CLI','# Wrangler CLI\n\nIn harnesst, `deploying-cloudflare-apps` owns credentials: use injected CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. If absent, block on the engineer. Interactive login, OAuth profiles and claim deployments are not the team credential path.'));
 }
 const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(path.relative(`${root}/files`,p));}}await walk(`${root}/files`);
 const manifest=JSON.parse(await readFile(`${root}/template.json`));manifest.files=files.sort();await writeFile(`${root}/template.json`,JSON.stringify(manifest,null,2)+'\n');
}
console.log(`Vendored ${commit}. Review the diff, bump versions, then run catalog:index and catalog:validate.`);
