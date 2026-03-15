// LeanRunner.js
// Usage: LeanRunner.buildLinks(leanSource [, opts])
// opts: { baseUrls, baseUrl, project, useCodez, codeUrl, maxUrlLength }

(function (global) {
  const LeanRunner = {};
  const DEFAULT_BASE_URLS = [
    'https://live.lean-lang.org/',
    'https://lean.math.hhu.de/'
  ];
  const DEFAULT_MAX_URL_LENGTH = 1800;
  const KEY_STR_URI_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';

  function normalizeBaseUrl(input) {
    if (!input) return '';
    const raw = String(input || '').trim();
    if (!raw) return '';
    try {
      const base = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : 'https://' + raw;
      const url = new URL(base, typeof window !== 'undefined' ? window.location.href : undefined);
      url.hash = '';
      url.search = '';
      let href = url.href;
      if (!href.endsWith('/')) href += '/';
      return href;
    } catch (err) {
      return '';
    }
  }

  function uniq(values) {
    const out = [];
    const seen = new Set();
    (values || []).forEach((value) => {
      const normalized = normalizeBaseUrl(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    });
    return out;
  }

  function compressToEncodedURIComponent(input) {
    if (input == null) return '';
    return _compress(input, 6, function (a) {
      return KEY_STR_URI_SAFE.charAt(a);
    });
  }

  function _compress(uncompressed, bitsPerChar, getCharFromInt) {
    if (uncompressed == null) return '';
    let i;
    let value;
    const dictionary = {};
    const dictionaryToCreate = {};
    let c = '';
    let wc = '';
    let w = '';
    let enlargeIn = 2;
    let dictSize = 3;
    let numBits = 2;
    const data = [];
    let dataVal = 0;
    let dataPosition = 0;

    for (let ii = 0; ii < uncompressed.length; ii += 1) {
      c = uncompressed.charAt(ii);
      if (!Object.prototype.hasOwnProperty.call(dictionary, c)) {
        dictionary[c] = dictSize++;
        dictionaryToCreate[c] = true;
      }

      wc = w + c;
      if (Object.prototype.hasOwnProperty.call(dictionary, wc)) {
        w = wc;
      } else {
        if (Object.prototype.hasOwnProperty.call(dictionaryToCreate, w)) {
          if (w.charCodeAt(0) < 256) {
            for (i = 0; i < numBits; i += 1) {
              dataVal = (dataVal << 1);
              if (dataPosition === bitsPerChar - 1) {
                dataPosition = 0;
                data.push(getCharFromInt(dataVal));
                dataVal = 0;
              } else {
                dataPosition += 1;
              }
            }
            value = w.charCodeAt(0);
            for (i = 0; i < 8; i += 1) {
              dataVal = (dataVal << 1) | (value & 1);
              if (dataPosition === bitsPerChar - 1) {
                dataPosition = 0;
                data.push(getCharFromInt(dataVal));
                dataVal = 0;
              } else {
                dataPosition += 1;
              }
              value = value >> 1;
            }
          } else {
            value = 1;
            for (i = 0; i < numBits; i += 1) {
              dataVal = (dataVal << 1) | value;
              if (dataPosition === bitsPerChar - 1) {
                dataPosition = 0;
                data.push(getCharFromInt(dataVal));
                dataVal = 0;
              } else {
                dataPosition += 1;
              }
              value = 0;
            }
            value = w.charCodeAt(0);
            for (i = 0; i < 16; i += 1) {
              dataVal = (dataVal << 1) | (value & 1);
              if (dataPosition === bitsPerChar - 1) {
                dataPosition = 0;
                data.push(getCharFromInt(dataVal));
                dataVal = 0;
              } else {
                dataPosition += 1;
              }
              value = value >> 1;
            }
          }
          enlargeIn -= 1;
          if (enlargeIn === 0) {
            enlargeIn = Math.pow(2, numBits);
            numBits += 1;
          }
          delete dictionaryToCreate[w];
        } else {
          value = dictionary[w];
          for (i = 0; i < numBits; i += 1) {
            dataVal = (dataVal << 1) | (value & 1);
            if (dataPosition === bitsPerChar - 1) {
              dataPosition = 0;
              data.push(getCharFromInt(dataVal));
              dataVal = 0;
            } else {
              dataPosition += 1;
            }
            value = value >> 1;
          }
        }
        enlargeIn -= 1;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits += 1;
        }
        dictionary[wc] = dictSize++;
        w = String(c);
      }
    }

    if (w !== '') {
      if (Object.prototype.hasOwnProperty.call(dictionaryToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          for (i = 0; i < numBits; i += 1) {
            dataVal = (dataVal << 1);
            if (dataPosition === bitsPerChar - 1) {
              dataPosition = 0;
              data.push(getCharFromInt(dataVal));
              dataVal = 0;
            } else {
              dataPosition += 1;
            }
          }
          value = w.charCodeAt(0);
          for (i = 0; i < 8; i += 1) {
            dataVal = (dataVal << 1) | (value & 1);
            if (dataPosition === bitsPerChar - 1) {
              dataPosition = 0;
              data.push(getCharFromInt(dataVal));
              dataVal = 0;
            } else {
              dataPosition += 1;
            }
            value = value >> 1;
          }
        } else {
          value = 1;
          for (i = 0; i < numBits; i += 1) {
            dataVal = (dataVal << 1) | value;
            if (dataPosition === bitsPerChar - 1) {
              dataPosition = 0;
              data.push(getCharFromInt(dataVal));
              dataVal = 0;
            } else {
              dataPosition += 1;
            }
            value = 0;
          }
          value = w.charCodeAt(0);
          for (i = 0; i < 16; i += 1) {
            dataVal = (dataVal << 1) | (value & 1);
            if (dataPosition === bitsPerChar - 1) {
              dataPosition = 0;
              data.push(getCharFromInt(dataVal));
              dataVal = 0;
            } else {
              dataPosition += 1;
            }
            value = value >> 1;
          }
        }
        enlargeIn -= 1;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits += 1;
        }
        delete dictionaryToCreate[w];
      } else {
        value = dictionary[w];
        for (i = 0; i < numBits; i += 1) {
          dataVal = (dataVal << 1) | (value & 1);
          if (dataPosition === bitsPerChar - 1) {
            dataPosition = 0;
            data.push(getCharFromInt(dataVal));
            dataVal = 0;
          } else {
            dataPosition += 1;
          }
          value = value >> 1;
        }
      }
      enlargeIn -= 1;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits += 1;
      }
    }

    value = 2;
    for (i = 0; i < numBits; i += 1) {
      dataVal = (dataVal << 1) | (value & 1);
      if (dataPosition === bitsPerChar - 1) {
        dataPosition = 0;
        data.push(getCharFromInt(dataVal));
        dataVal = 0;
      } else {
        dataPosition += 1;
      }
      value = value >> 1;
    }

    while (true) {
      dataVal = (dataVal << 1);
      if (dataPosition === bitsPerChar - 1) {
        data.push(getCharFromInt(dataVal));
        break;
      } else {
        dataPosition += 1;
      }
    }

    return data.join('');
  }

  LeanRunner.buildLinks = function buildLinks(code, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const baseList = [];
    if (typeof options.baseUrl === 'string') baseList.push(options.baseUrl);
    if (Array.isArray(options.baseUrls)) baseList.push(...options.baseUrls);
    if (baseList.length === 0) baseList.push(...DEFAULT_BASE_URLS);
    const baseUrls = uniq(baseList);
    if (baseUrls.length === 0) {
      return { ok: false, reason: 'No Lean4web base URL configured.' };
    }

    const project = typeof options.project === 'string' ? options.project.trim() : '';
    const codeUrl = typeof options.codeUrl === 'string' ? options.codeUrl.trim() : '';
    const useCodez = options.useCodez !== false;
    const maxUrlLength = Number.isFinite(options.maxUrlLength) ? options.maxUrlLength : DEFAULT_MAX_URL_LENGTH;
    const source = String(code || '');
    if (!source && !codeUrl) {
      return { ok: false, reason: 'Lean code is empty.' };
    }

    const params = [];
    if (project) params.push('project=' + encodeURIComponent(project));

    let payloadType = 'code';
    let payloadValue = '';
    let usedCompression = false;
    if (codeUrl) {
      payloadType = 'url';
      payloadValue = encodeURIComponent(codeUrl);
    } else if (useCodez) {
      payloadType = 'codez';
      payloadValue = compressToEncodedURIComponent(source);
      usedCompression = true;
    } else {
      payloadType = 'code';
      payloadValue = encodeURIComponent(source);
    }

    if (!payloadValue) {
      return { ok: false, reason: 'Failed to encode Lean code for Lean4web.' };
    }

    params.push(payloadType + '=' + payloadValue);
    const fragment = '#' + params.join('&');
    const urls = baseUrls.map((base) => base + fragment);
    const tooLong = urls.some((url) => url.length > maxUrlLength);
    const warning = (tooLong && !codeUrl)
      ? 'Lean4web link is long and may exceed some URL limits.'
      : '';

    return {
      ok: true,
      urls,
      primaryUrl: urls[0],
      baseUrls,
      project,
      payloadType,
      usedCompression,
      payloadLength: payloadValue.length,
      fragmentLength: fragment.length,
      tooLong,
      maxUrlLength,
      warning
    };
  };

  LeanRunner.DEFAULT_BASE_URLS = DEFAULT_BASE_URLS.slice();
  LeanRunner.DEFAULT_MAX_URL_LENGTH = DEFAULT_MAX_URL_LENGTH;

  if (!global.LeanRunner) global.LeanRunner = LeanRunner;
})(typeof window !== 'undefined' ? window : globalThis);
