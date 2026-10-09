/**
 * The bridge SCRIPT and its injection — the server half of `artifact-bridge.ts` (read that for the
 * protocol and why it grants nothing). Ported from Omniplex's `bridgeScript`/`injectBridge`.
 *
 * The script runs first in every HTML document the preview and share routes serve:
 *
 *   - STORAGE SHIM. The sandbox gives the page an opaque origin, so `localStorage` and
 *     `sessionStorage` throw on access and a prototype that saves its state dies on load. The
 *     script swaps in an in-memory store that lasts as long as the page does. It is never shared
 *     with anything — not across pages, not with harnesst.
 *   - When framed, it reports location and console OUT to `window.parent` (target `"*"`: the
 *     parent's origin is harnesst's, but the page cannot know which of the app/preview origins that
 *     is, and nothing it sends is secret from the page itself), and accepts back/forward from the
 *     parent only.
 *
 * It also adds a viewport `<meta>` when the page has none: without it a phone lays the page out
 * 980px wide and shrinks it to fit, so a shared link opens as a postage stamp. In the panel's frame
 * it changes nothing — a frame is already as wide as it is drawn.
 *
 * Operates on byte-strings (latin1-decoded), like `artifact-urls.ts`, so pages in any
 * ASCII-compatible encoding round-trip exactly.
 */
import {
  ARTIFACT_BRIDGE_MAX_ARG_CHARS,
  ARTIFACT_BRIDGE_MAX_ARGS,
  ARTIFACT_BRIDGE_SOURCE,
} from "~/foh/artifact-bridge";

/**
 * Plain ES5 on purpose — it runs before the page's own code, in whatever browser opened a share
 * link, and must never be the thing that throws. Every hook is wrapped so a hostile or broken page
 * can at worst make the bridge go quiet.
 */
const BRIDGE_SCRIPT = `<script>(function(){
var S=${JSON.stringify(ARTIFACT_BRIDGE_SOURCE)},MAXC=${ARTIFACT_BRIDGE_MAX_ARG_CHARS},MAXA=${ARTIFACT_BRIDGE_MAX_ARGS};
function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){var ks=Object.keys(d);return i<ks.length?ks[i]:null},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}});
var P=window.parent;if(P===window)return;
function send(m){m.source=S;try{P.postMessage(m,"*")}catch(e){}}
var PFX=(location.pathname.match(/^\\/artifacts\\/preview\\/[^\\/]+\\/[^\\/]+\\//)||location.pathname.match(/^\\/a\\/[^\\/]+\\//)||[""])[0];
function scrub(s){return PFX?s.split(location.origin+PFX).join("/").split(PFX).join("/"):s}
function cap(s){s=scrub(String(s));return s.length>MAXC?s.slice(0,MAXC-1)+"\\u2026":s}
function where(){var p=location.pathname;if(PFX&&p.indexOf(PFX)===0)p="/"+p.slice(PFX.length);try{p=decodeURI(p)}catch(e){}return p+location.search+location.hash}
function loc(){send({type:"location",href:cap(where()),title:cap(document.title||"")})}
addEventListener("load",loc);addEventListener("popstate",loc);addEventListener("hashchange",loc);
function fmt(a){if(typeof a==="string")return a;if(a instanceof Error)return a.stack||String(a);try{var j=JSON.stringify(a);return j===undefined?String(a):j}catch(e){return String(a)}}
function args(list){var out=[];for(var i=0;i<list.length&&i<MAXA;i++)out.push(cap(fmt(list[i])));return out}
["log","info","warn","error","debug"].forEach(function(l){var o=console[l];console[l]=function(){try{send({type:"console",level:l,args:args(arguments)})}catch(e){}if(o)return o.apply(console,arguments)}});
addEventListener("error",function(e){send({type:"console",level:"error",args:[cap(String(e.message)+(e.filename?" ("+scrub(String(e.filename))+":"+e.lineno+")":""))]})});
addEventListener("unhandledrejection",function(e){send({type:"console",level:"error",args:[cap("Unhandled rejection: "+fmt(e.reason))]})});
addEventListener("message",function(e){if(e.source!==P||!e.data||e.data.source!==S||e.data.type!=="nav")return;if(e.data.dir==="back")history.back();else if(e.data.dir==="forward")history.forward()});
})();</script>`;

const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

const HAS_VIEWPORT = /<meta[^>]*name[\t\n\f\r ]*=[\t\n\f\r ]*["']?viewport/i;

/**
 * Put the bridge first in the document's head — so it hooks the console before the page's own
 * scripts run — plus a viewport meta when the head has none. After `<head …>` when there is one in
 * the first 4 KiB, else after `<html …>`, else at the very start (a fragment the browser wraps in
 * an implied head anyway).
 */
export function injectArtifactBridge(doc: string): string {
  let head = doc.slice(0, 16384);
  const close = head.search(/<\/head/i);
  if (close >= 0) head = head.slice(0, close);
  const inject = HAS_VIEWPORT.test(head)
    ? BRIDGE_SCRIPT
    : BRIDGE_SCRIPT + VIEWPORT_META;

  const early = head.slice(0, 4096);
  let at = 0;
  const open =
    /<head(?=[\t\n\f\r />])/i.exec(early) ??
    /<html(?=[\t\n\f\r />])/i.exec(early);
  if (open) {
    const gt = doc.indexOf(">", open.index);
    if (gt >= 0) at = gt + 1;
  }
  return doc.slice(0, at) + inject + doc.slice(at);
}
