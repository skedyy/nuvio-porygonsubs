/**
 * PorygonSubs - scraper local para Nuvio
 * Escrito con Promises (sin async/await) y sin sintaxis moderna para que
 * corra tal cual en Hermes, sin paso de build.
 *
 * Flujo (verificado con un HAR de /ver/horizontes-pokemon-153):
 *  1. TMDB id -> titulo -> slug de la serie en el sitio
 *  2. GET /ver/{slug}-{n}  -> los botones de servidor ya traen el codigo del
 *     embed en data-codigo (base64 doble). No hace falta Livewire para FM/MP4U.
 *  3. Extractor por servidor (MP4U verificado; DOOD/VOE = base a ajustar; FM no soportado)
 */

var BASE = 'https://porygonsubs.com';
var TMDB_KEY = 'TU_API_KEY_DE_TMDB';

// Alias manuales: tmdbId -> slug del sitio (lo que va en porygonsubs.com/{slug}).
// El titulo de TMDB casi nunca coincide con el del sitio (p. ej. "Pokemon Horizons"
// vs "horizontes-pokemon"), asi que aqui se resuelve a mano. Con alias NO se llama a TMDB.
// Formato: 'ID_TMDB': 'slug'   (el ID esta en la URL themoviedb.org/tv/ID)
var ALIASES = {
  '220150': 'horizontes-pokemon',
};

// Proxy opcional (ver worker/worker.js). Si lo pones, los streams MP4 salen como una URL
// autosuficiente (sin headers), que es lo unico que entienden los reproductores externos
// y los gestores de descarga. Ej.: 'https://porygon-proxy.TU_USUARIO.workers.dev'
var PROXY_URL = 'https://porygon-proxy.tigader833.workers.dev/';

// Dominios que el Worker acepta (debe coincidir con ALLOWED_HOSTS del Worker).
// Lo que NO este aqui sale directo (con headers), para no romper la reproduccion en la app.
// Para DOOD agrega el dominio del CDN (lo ves con PORY_DEBUG=1), p. ej. 'cloudatacdn.com'.
var PROXY_HOSTS = ['mp4upload.com'];

function hostOf(u) { return ((String(u).match(/^https?:\/\/([^/:?#]+)/i) || [])[1] || '').toLowerCase(); }
function proxyAllowed(u) {
  var h = hostOf(u);
  if (PROXY_HOSTS.indexOf('*') !== -1) return true;   // modo descubrimiento (temporal)
  return PROXY_HOSTS.some(function (a) { return h === a || h.slice(-(a.length + 1)) === '.' + a; });
}

function viaProxy(res) {
  if (!PROXY_URL || !res) return res;
  if (!proxyAllowed(res.url)) { log('sin proxy (host no permitido):', hostOf(res.url)); return res; }
  var ref = (res.headers && (res.headers.Referer || res.headers.referer)) || '';
  return { url: PROXY_URL.replace(/\/+$/, '') + '/?u=' + encodeURIComponent(res.url) + '&r=' + encodeURIComponent(ref), headers: {} };
}

var DEBUG = (typeof process !== 'undefined' && process.env && process.env.PORY_DEBUG) ? true : false;
function log() { if (DEBUG) { try { console.log.apply(console, ['[pory]'].concat([].slice.call(arguments))); } catch (e) {} } }

var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// ---------- utilidades ----------
function get(url, headers) {
  var h = { 'User-Agent': UA };
  for (var k in (headers || {})) h[k] = headers[k];
  return fetch(url, { headers: h });
}
function getText(url, headers) {
  return get(url, headers).then(function (r) { return r.ok ? r.text() : null; });
}

// Cookies de sesion: fetch en Node no guarda cookies y Livewire (Laravel) las exige
// junto con el token CSRF. En React Native el cookie jar nativo ayuda, pero las
// reenviamos a mano por si acaso.
function collectCookies(res) {
  var list = [];
  try { if (res.headers && res.headers.getSetCookie) list = res.headers.getSetCookie(); } catch (e) {}
  if (!list.length && res.headers && res.headers.get) {
    var sc = res.headers.get('set-cookie');
    if (sc) list = sc.split(/,(?=\s*[^;,=\s]+=)/);
  }
  return list.map(function (c) { return c.split(';')[0].trim(); }).filter(Boolean).join('; ');
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(str) {            // no dependemos de atob en Hermes
  str = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  var out = '', bits = 0, acc = 0;
  for (var i = 0; i < str.length; i++) {
    acc = (acc << 6) | B64.indexOf(str.charAt(i));
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
  }
  return out;
}
function decodeCodigo(c) { return b64decode(b64decode(c)); }   // data-codigo = base64(base64(id))

// ---------- 1) TMDB -> slug del sitio ----------
function getTmdb(tmdbId, type) {
  var kind = type === 'movie' ? 'movie' : 'tv';
  return get('https://api.themoviedb.org/3/' + kind + '/' + tmdbId + '?language=es-MX&api_key=' + TMDB_KEY)
    .then(function (r) { return r.json(); });
}

function findSlug(titles, season) {
  var c = [];
  titles.forEach(function (t) {
    var s = slugify(t);
    if (season > 1) { c.push(s + '-season-' + season, s + '-' + season); }
    c.push(s);
  });
  c = c.filter(function (x, i) { return x && c.indexOf(x) === i; });
  var i = 0;
  function next() {
    if (i >= c.length) return Promise.resolve(null);
    var slug = c[i++];
    return getText(BASE + '/' + slug).then(function (html) {
      // la pagina de serie enlaza a /ver/{slug}-N
      return html && html.indexOf('/ver/' + slug + '-') !== -1 ? slug : next();
    }).catch(next);
  }
  return next();
}

// ---------- 2) parseo de la pagina del episodio ----------
// <button wire:click="selecServer({idioma: 6812, slug: 'fm'})" data-slug="fm" data-codigo="...">
function parseServers(html) {
  var out = [], re = /<button[^>]*data-slug="([^"]+)"[^>]*data-codigo="([^"]*)"[^>]*>/g, m;
  var idRe = /idioma:\s*(\d+)/;
  while ((m = re.exec(html))) {
    var tag = m[0];
    var before = html.slice(Math.max(0, m.index - 1500), m.index);
    var lang = (before.match(/(Sub Espa\u00f1ol|Sub Latino|Latino|Castellano)(?![\s\S]*(Sub Espa\u00f1ol|Sub Latino|Latino|Castellano))/) || [])[1] || 'Sub Espa\u00f1ol';
    out.push({
      slug: m[1],
      codigo: m[2],
      id: decodeCodigo(m[2]),
      idioma: (tag.match(idRe) || [])[1] || null,
      lang: lang
    });
  }
  return out;
}

// URL del embed. FM y MP4U confirmados en el HAR. VOE/DOOD: ver Livewire abajo.
function embedUrl(s) {
  switch (s.slug) {
    case 'fm':   return 'https://bysefujedu.com/e/' + s.id;
    case 'mp4u': return 'https://www.mp4upload.com/embed-' + s.id + '.html';
    default:     return null;
  }
}

// Para VOE/DOOD (dominio desconocido): el propio sitio devuelve la URL real via
// Livewire -> selecServer. Requiere token CSRF + cookies de sesion del GET previo.
function livewireEmbed(html, s, cookie) {
  var csrf = (html.match(/name="csrf-token"\s+content="([^"]+)"/) || [])[1];
  var upd = (html.match(/data-update-uri="([^"]+)"/) || [])[1] || (BASE + '/livewire-7b0aaefc/update');
  var re = /wire:snapshot="([^"]+)"/g, m, snap = null;
  while ((m = re.exec(html))) {
    var raw = m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (raw.indexOf('"frontend.capitulos"') !== -1) { snap = raw; break; }
  }
  log('livewire: csrf', csrf ? 'OK' : 'NO', '| snapshot', snap ? 'OK' : 'NO', '| cookies', cookie ? cookie.split(';').length : 0, '| uri', upd);
  if (!csrf || !snap) return Promise.resolve(null);
  var headers = { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': '*/*', 'X-Livewire': '1', 'Origin': BASE, 'Referer': BASE + '/' };
  if (cookie) headers['Cookie'] = cookie;
  return fetch(upd, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      _token: csrf,
      components: [{ snapshot: snap, updates: {},
        calls: [{ path: '', method: 'selecServer', params: [{ idioma: Number(s.idioma), slug: s.slug }], metadata: {} }] }]
    })
  }).then(function (r) {
    log('livewire', s.slug, 'HTTP', r.status);
    return r.text().then(function (t) {
      if (!r.ok) { log('livewire cuerpo:', t.slice(0, 200)); return null; }
      var j = JSON.parse(t);
      var data = JSON.parse(j.components[0].snapshot).data;
      return data.embed || null;
    });
  }).catch(function (e) { log('livewire error:', e && e.message); return null; });
}

// ---------- 3) extractores ----------
function mp4uExtract(embed) {         // VERIFICADO con el HAR
  return getText(embed, { Referer: BASE + '/' }).then(function (html) {
    var m = html && html.match(/player\.src\(\s*\{[^}]*?src:\s*"(https?:[^"]+)"/);
    return m ? { url: m[1], headers: { Referer: 'https://www.mp4upload.com/', 'User-Agent': UA } } : null;
  });
}

var RND = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function doodExtract(embed) {         // patron clasico /pass_md5/ (sin verificar en este sitio)
  var u = embed.replace('/d/', '/e/');
  var host = (u.match(/^https?:\/\/[^/]+/) || [''])[0];
  log('dood: pidiendo embed', u);
  return get(u, { Referer: BASE + '/' }).then(function (r) {
    log('dood: embed HTTP', r.status, '| url final', r.url || u);
    return r.ok ? r.text() : null;
  }).then(function (html) {
    if (!html) return null;
    var md5 = html.match(/\/pass_md5\/[^'"]+/);
    log('dood: html', html.length, 'bytes | pass_md5', md5 ? 'OK' : 'NO ENCONTRADO', md5 ? '' : '| inicio: ' + html.slice(0, 150).replace(/\s+/g, ' '));
    if (!md5) return null;
    var token = md5[0].split('/').pop();
    return getText(host + md5[0], { Referer: u }).then(function (base) {
      log('dood: pass_md5 respondio', base ? base.slice(0, 80) : 'vacio');
      if (!base || base.indexOf('http') !== 0) return null;
      var rnd = ''; for (var i = 0; i < 10; i++) rnd += RND.charAt(Math.floor(Math.random() * 62));
      return { url: base + rnd + '?token=' + token + '&expiry=' + Date.now(), headers: { Referer: host + '/', 'User-Agent': UA } };
    });
  });
}

function unpack(code) {               // Dean Edwards p,a,c,k,e,d
  var m = code.match(/\}\('([\s\S]*)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var p = m[1], a = +m[2], c = +m[3], k = m[4].split('|');
  function enc(n) { return (n < a ? '' : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  var d = {}; while (c--) d[enc(c)] = k[c] || enc(c);
  return p.replace(/\\'/g, "'").replace(/\b\w+\b/g, function (w) { return d[w] || w; });
}

// VOE responde con una pagina "Redirecting..." que salta por JS a un dominio espejo
// (window.location.href = 'https://...'). fetch no ejecuta JS, asi que seguimos el salto a mano.
function fetchFollowingJsRedirect(url, referer, hops) {
  return getText(url, { Referer: referer }).then(function (html) {
    if (!html) return { html: null, url: url };
    var m = html.length < 3000 && html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
    if (m && hops > 0 && m[1] !== url) {
      log('redirect JS ->', m[1]);
      return fetchFollowingJsRedirect(m[1], url, hops - 1);
    }
    return { html: html, url: url };
  });
}

function genericExtract(embed) {      // VOE (base): busca un .m3u8/.mp4 en la pagina final
  return fetchFollowingJsRedirect(embed, BASE + '/', 2).then(function (r) {
    var html = r.html;
    if (!html) return null;
    log('voe/generic: pagina final', r.url, html.length, 'bytes');
    var packed = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/);
    var src = packed ? (unpack(packed[0]) || html) : html;
    var m = src.match(/https?:[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*/);
    if (!m) log('voe/generic: sin .m3u8/.mp4 en claro');
    return m ? { url: m[0].replace(/\\\//g, '/'), headers: { Referer: r.url, 'User-Agent': UA } } : null;
  });
}

// ---- VOE ----
// La pagina final del espejo trae <script type="application/json">["...cadena ofuscada..."]</script>.
// Cadena: rot13 -> quitar basura (@$ ^^ ~@ %? *~ !! #&) -> base64 -> restar 3 a cada char
//         -> invertir -> base64 -> JSON con { source: master.m3u8, direct_access_url: mp4, ... }
// VOE cambia este esquema de vez en cuando: si falla, el log lo dice y se cae al regex generico.
function rot13(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    var b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
  });
}
var VOE_JUNK = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
function voeDecode(blob) {
  var str = rot13(JSON.parse(blob)[0]);
  VOE_JUNK.forEach(function (j) { str = str.split(j).join(''); });
  str = b64decode(str);
  var t = '';
  for (var i = 0; i < str.length; i++) t += String.fromCharCode(str.charCodeAt(i) - 3);
  t = t.split('').reverse().join('');
  return JSON.parse(b64decode(t));
}

function voeExtract(embed) {
  return fetchFollowingJsRedirect(embed, BASE + '/', 2).then(function (r) {
    if (!r.html) return null;
    var origin = (r.url.match(/^https?:\/\/[^/]+/) || [''])[0];
    var m = r.html.match(/<script type="application\/json">(\[[\s\S]*?\])<\/script>/);
    log('voe: pagina final', r.url, '| bloque json', m ? 'OK' : 'NO');
    if (m) {
      try {
        var j = voeDecode(m[1]);
        // direct_access_url solo se usa si el propio VOE lo habilita (direct_access_allowed); si no, HLS.
        var u = (j.direct_access_allowed === true && j.direct_access_url) ? j.direct_access_url : (j.source || null);
        log('voe: decodificado | source', j.source ? hostOf(j.source) : '-', '| direct_access', j.direct_access_url ? hostOf(j.direct_access_url) : '-');
        if (u) return { url: u, headers: { Referer: origin + '/', 'User-Agent': UA } };
      } catch (e) { log('voe: error al decodificar:', e && e.message); }
    }
    return genericExtract(embed);
  });
}

// FM esta desactivado a proposito: su reproductor exige un token de captcha y una
// atestacion de dispositivo (ver README/notas), asi que no hay forma legitima de
// obtener el stream desde un plugin. No se intenta para no gastar peticiones.
var EXTRACTORS = { mp4u: mp4uExtract, dood: doodExtract, voe: voeExtract };
// Etiquetas visibles en Nuvio. El sufijo " (solo reproducir)" se agrega solo a los streams que salen
// DIRECTOS (con headers): sirven en el player interno, pero no para descargar ni reproductor externo.
// Los que salen por el proxy (URL sin headers) llevan el nombre limpio = aptos para descargar.
// VOE lleva rayo: es el mas rapido.
var LABEL = { fm: 'FM', voe: 'VOE \u26A1', dood: 'DOOD', mp4u: 'MP4U' };

// Servidores a ocultar por completo, p. ej. ['dood'] para que no aparezca en la lista.
var DISABLED_SERVERS = [];

// Servidores que NUNCA pasan por el proxy: solo reproducir (VOE es HLS y el downloader de Nuvio
// no baja HLS; ademas ya es rapido en directo).
var PLAY_ONLY = ['voe'];

// Servidores que se ofrecen DOS veces (directa + "(descarga/externo)" por proxy). Vacio por ahora.
var DUAL_STREAMS = [];
// 'mega' se omite: archivo cifrado, no hay URL directa reproducible.

// ---------- 4) entrada para Nuvio ----------
function resolveSlug(tmdbId, mediaType, season) {
  var isMovie = mediaType === 'movie';
  log('tmdbId recibido:', JSON.stringify(tmdbId), '| alias definidos para:', Object.keys(ALIASES).join(', ') || '(ninguno)');
  var forced = (typeof process !== 'undefined' && process.env && process.env.PORY_SLUG) || ALIASES[String(tmdbId).trim()];
  if (forced) {
    log('slug por alias/PORY_SLUG:', forced);
    return Promise.resolve({ slug: forced, titles: [forced], info: null });
  }
  if (!TMDB_KEY || TMDB_KEY.indexOf('TU_API_KEY') === 0) log('AVISO: TMDB_KEY sin configurar');
  return getTmdb(tmdbId, mediaType).then(function (info) {
    if (!info || !(info.title || info.name)) { log('TMDB no devolvio titulo (API key mala o ID incorrecto):', JSON.stringify(info).slice(0, 200)); return null; }
    var titles = [info.title || info.name, info.original_title || info.original_name].filter(Boolean);
    log('titulos TMDB:', titles);
    return findSlug(titles, isMovie ? 1 : season).then(function (slug) {
      log('slug encontrado:', slug);
      return slug ? { slug: slug, titles: titles, info: info } : null;
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var isMovie = mediaType === 'movie';
  return resolveSlug(tmdbId, mediaType, season).then(function (r) {
    if (!r) { log('sin slug -> []. Agrega un alias en ALIASES.'); return []; }
    var slug = r.slug, titles = r.titles, info = r.info;

    // numero de episodio: relativo y, si no existe, absoluto (suma de temporadas previas)
    var nums = [isMovie ? 1 : episode];
    if (!isMovie && info && info.seasons) {
      var abs = episode;
      info.seasons.forEach(function (s) { if (s.season_number > 0 && s.season_number < season) abs += s.episode_count; });
      if (abs !== episode) nums.push(abs);
    }
    var j = 0;
    function tryEp() {
      if (j >= nums.length) return Promise.resolve(null);
      var url = BASE + '/ver/' + slug + '-' + nums[j++];
      return get(url).then(function (res) {
        var cookie = collectCookies(res);
        return (res.ok ? res.text() : Promise.resolve(null)).then(function (html) {
          log('GET', url, html ? 'OK' : 'no existe', '| set-cookie:', cookie ? 'si' : 'no');
          return html ? { url: url, html: html, cookie: cookie } : tryEp();
        });
      }).catch(tryEp);
    }

    return tryEp().then(function (page) {
      if (!page) return [];
      var all = parseServers(page.html);
      log('servidores en pagina:', all.map(function (x) { return x.slug; }).join(','));
      var servers = all.filter(function (x) { return EXTRACTORS[x.slug] && DISABLED_SERVERS.indexOf(x.slug) === -1; });
      return Promise.all(servers.map(function (sv) {
        var emb = embedUrl(sv);
        var p = emb ? Promise.resolve(emb) : livewireEmbed(page.html, sv, page.cookie);
        return p.then(function (e) { log(sv.slug, 'embed:', e); return e ? EXTRACTORS[sv.slug](e) : null; })
          .then(function (res) {
            log(sv.slug, res ? 'stream OK' : 'sin stream');
            if (!res) return [];
            log(sv.slug, 'stream host:', hostOf(res.url));
            var direct = res;
            var prox = PLAY_ONLY.indexOf(sv.slug) !== -1 ? direct : viaProxy(res);
            var title = titles[0] + ' (' + sv.lang + ')';
            var mk = function (suffix, r) { return { name: 'PorygonSubs - ' + LABEL[sv.slug] + suffix, title: title, url: r.url, quality: 'HD', headers: r.headers }; };
            var PLAY = ' (solo reproducir)';
            if (prox === direct) return [mk(PLAY, direct)];
            if (DUAL_STREAMS.indexOf(sv.slug) !== -1) return [mk(PLAY, direct), mk('', prox)];
            return [mk('', prox)];
          }).catch(function (err) { log(sv.slug, 'error:', err && err.message); return []; });
      })).then(function (out) { return [].concat.apply([], out); });
    });
  }).catch(function (err) { log('ERROR:', err && err.message); return []; });
}

var API = { getStreams: getStreams, _internal: { parseServers: parseServers, decodeCodigo: decodeCodigo, mp4uExtract: mp4uExtract, unpack: unpack, embedUrl: embedUrl } };
if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
if (typeof globalThis !== 'undefined') { globalThis.getStreams = getStreams; }
else if (typeof global !== 'undefined') { global.getStreams = getStreams; }
