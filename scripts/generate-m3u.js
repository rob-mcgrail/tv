const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const NZ_PLAYLIST_URL = 'https://i.mjh.nz/nz/raw-tv.m3u8';
const AU_PLAYLIST_URL = 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/au.m3u';
const UK_PLAYLIST_URL = 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/uk.m3u';
const CACHE_FILE = path.join(__dirname, '..', 'stream-cache.json');
const CACHE_EXPIRY_DAYS = 7;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cache = JSON.parse(data);
      const expiryTime = Date.now() - (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      
      // Filter out expired entries
      const validCache = {};
      for (const [url, result] of Object.entries(cache)) {
        if (result.timestamp && result.timestamp > expiryTime) {
          validCache[url] = result;
        }
      }
      
      console.log(`✓ Loaded ${Object.keys(validCache).length} cached stream results`);
      return validCache;
    }
  } catch (error) {
    console.log('⚠ Could not load cache:', error.message);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`✓ Saved ${Object.keys(cache).length} stream results to cache`);
  } catch (error) {
    console.log('⚠ Could not save cache:', error.message);
  }
}

async function fetchPlaylist(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Failed to fetch playlist: ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function checkStream(url, timeout = 5000, redirectCount = 0) {
  const maxRedirects = 5;
  
  return new Promise((resolve) => {
    let isResolved = false;
    
    const safeResolve = (result) => {
      if (!isResolved) {
        isResolved = true;
        resolve(result);
      }
    };
    
    // Set an absolute timeout as a failsafe
    const absoluteTimeout = setTimeout(() => {
      safeResolve({
        url,
        working: false,
        error: 'Absolute timeout'
      });
    }, timeout + 1000);
    
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const request = protocol.get(url, {
      timeout: timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.128 Safari/537.36'
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        request.destroy();
        clearTimeout(absoluteTimeout);
        
        if (redirectCount >= maxRedirects) {
          safeResolve({
            url,
            working: false,
            error: 'Too many redirects'
          });
          return;
        }
        
        // Follow the redirect
        const redirectUrl = new URL(res.headers.location, url).href;
        checkStream(redirectUrl, timeout, redirectCount + 1).then((result) => {
          safeResolve(result);
        });
        return;
      }
      
      let data = '';
      let bytesReceived = 0;
      const maxBytes = 4096; // Read first 4KB to validate
      
      // Check if status code indicates success
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        request.destroy();
        clearTimeout(absoluteTimeout);
        safeResolve({
          url,
          working: false,
          statusCode: res.statusCode
        });
        return;
      }
      
      res.on('data', (chunk) => {
        bytesReceived += chunk.length;
        data += chunk.toString();
        
        // Stop reading after we have enough data
        if (bytesReceived >= maxBytes) {
          res.destroy();
        }
      });
      
      res.on('end', () => {
        request.destroy();
        clearTimeout(absoluteTimeout);
        
        // For m3u8 files, check if it's a valid HLS playlist
        if (url.includes('.m3u8')) {
          const hasValidHLS = data.includes('#EXTM3U') || 
                             data.includes('#EXT-X-') ||
                             data.includes('.ts') ||
                             data.includes('.m3u8');
          
          if (!hasValidHLS) {
            safeResolve({
              url,
              working: false,
              error: 'Invalid HLS content'
            });
            return;
          }
        }
        
        // Check if we got any data
        if (bytesReceived === 0) {
          safeResolve({
            url,
            working: false,
            error: 'No data received'
          });
          return;
        }
        
        safeResolve({
          url,
          working: true,
          statusCode: res.statusCode,
          bytes: bytesReceived
        });
      });
      
      res.on('error', (err) => {
        request.destroy();
        clearTimeout(absoluteTimeout);
        safeResolve({
          url,
          working: false,
          error: err.message
        });
      });
    });
    
    request.on('error', (err) => {
      clearTimeout(absoluteTimeout);
      safeResolve({
        url,
        working: false,
        error: err.message
      });
    });
    
    request.on('timeout', () => {
      request.destroy();
      clearTimeout(absoluteTimeout);
      safeResolve({
        url,
        working: false,
        error: 'Timeout'
      });
    });
  });
}

function deduplicateChannels(streams) {
  const seen = new Map();
  const unique = [];
  
  // Australian states/territories to strip from channel names
  const auRegions = [
    'nsw', 'vic', 'qld', 'sa', 'wa', 'tas', 'nt', 'act',
    'new south wales', 'victoria', 'queensland', 'south australia',
    'western australia', 'tasmania', 'northern territory',
    'australian capital territory', 'australia', 'au',
    'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
    'hobart', 'darwin', 'canberra'
  ];
  
  for (const stream of streams) {
    // Extract channel name from EXTINF line
    const nameMatch = stream.extinf.match(/,\s*(.+)$/);
    let channelName = nameMatch ? nameMatch[1].trim().toLowerCase() : '';
    
    // Remove common prefixes/suffixes and normalize
    let baseName = channelName
      .replace(/\s*\(.*?\)\s*/g, '') // Remove parenthetical content
      .replace(/\s*\[.*?\]\s*/g, '') // Remove bracketed content
      .replace(/\s+hd$/i, '') // Remove HD suffix
      .replace(/\s+\+\d+$/i, '') // Remove +1 style suffixes
      .trim();
    
    // Remove state/region identifiers
    for (const region of auRegions) {
      const regex = new RegExp(`\\b${region}\\b`, 'gi');
      baseName = baseName.replace(regex, '').trim();
    }
    
    // Clean up multiple spaces and special chars for comparison
    const compareKey = baseName.replace(/[^a-z0-9]/g, '').toLowerCase();
    const urlKey = stream.url.toLowerCase();
    
    // Skip if we've seen this exact URL
    if (seen.has(urlKey)) {
      continue;
    }
    
    // Check if we've seen this base channel name already
    let isDuplicate = false;
    for (const [seenUrl, seenKey] of seen.entries()) {
      if (seenKey === compareKey && compareKey.length > 0) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      seen.set(urlKey, compareKey);
      unique.push(stream);
    }
  }
  
  return unique;
}

function filterUnwantedChannels(streams) {
  const unwantedKeywords = [
    // Religious
    'hope channel', 'shine', 'gospel', 'church', 'christian', 'faith',
    'god', 'bible', 'christ', 'prayer', 'worship', 'religious',
    
    // Shopping
    'tvsn', 'shopping', 'expo channel', 'qvc', 'jewellery', 'jewelry',
    'beauty', 'shop', 'buy', 'home shopping',
    
    // Kids
    'cbeebies', 'cbbc',
    
    // Other
    'liveevent'
  ];
  
  // Allowed AU channels (everything else from AU will be filtered out)
  const allowedAUChannels = ['abc', 'channel 44', 'c31'];
  
  // Allowed UK channels (everything else from UK will be filtered out)
  const allowedUKChannels = ['cnbc', 'iraninternational', 'bloomberg', 'bbc'];
  
  return streams.filter(stream => {
    const nameMatch = stream.extinf.match(/,\s*(.+)$/);
    const channelName = nameMatch ? nameMatch[1].trim().toLowerCase() : '';
    
    // Check if channel name contains any unwanted keywords
    for (const keyword of unwantedKeywords) {
      if (channelName.includes(keyword)) {
        return false;
      }
    }
    
    // For AU channels, only allow specific ones
    if (stream.source === 'AU') {
      let isAllowed = false;
      for (const allowed of allowedAUChannels) {
        if (channelName.includes(allowed)) {
          isAllowed = true;
          break;
        }
      }
      if (!isAllowed) {
        return false;
      }
    }
    
    // For UK channels, only allow specific ones
    if (stream.source === 'UK') {
      let isAllowed = false;
      for (const allowed of allowedUKChannels) {
        if (channelName.includes(allowed)) {
          isAllowed = true;
          break;
        }
      }
      if (!isAllowed) {
        return false;
      }
    }
    
    return true;
  });
}

function sortChannels(streams) {
  return streams.sort((a, b) => {
    // Extract channel-id from EXTINF line
    const getChannelId = (extinf) => {
      const match = extinf.match(/channel-id="([^"]+)"/);
      return match ? match[1] : '';
    };
    
    const channelIdA = getChannelId(a.extinf);
    const channelIdB = getChannelId(b.extinf);
    
    // Check if channels belong to groups we want at the end
    const isDiscoveryA = channelIdA.startsWith('mjh-discovery-');
    const isDiscoveryB = channelIdB.startsWith('mjh-discovery-');
    const isMoodA = channelIdA.startsWith('mjh-mood-');
    const isMoodB = channelIdB.startsWith('mjh-mood-');
    
    // Move discovery channels to the end
    if (isDiscoveryA && !isDiscoveryB) return 1;
    if (!isDiscoveryA && isDiscoveryB) return -1;
    
    // Move mood channels to the end
    if (isMoodA && !isMoodB) return 1;
    if (!isMoodA && isMoodB) return -1;
    
    // Extract tvg-chno for numeric sorting
    const getChannelNumber = (extinf) => {
      const match = extinf.match(/tvg-chno="(\d+)"/);
      return match ? parseInt(match[1], 10) : 999999;
    };
    
    const chnoA = getChannelNumber(a.extinf);
    const chnoB = getChannelNumber(b.extinf);
    
    // Sort by channel number if both have one
    if (chnoA !== 999999 && chnoB !== 999999) {
      return chnoA - chnoB;
    }
    
    // Channels with numbers come before those without
    if (chnoA !== 999999) return -1;
    if (chnoB !== 999999) return 1;
    
    // Otherwise maintain original order
    return 0;
  });
}

async function generatePlaylist() {
  try {
    console.log('Fetching New Zealand playlist from:', NZ_PLAYLIST_URL);
    const nzContent = await fetchPlaylist(NZ_PLAYLIST_URL);
    console.log('✓ NZ Playlist fetched successfully');
    
    console.log('Fetching Australian playlist from:', AU_PLAYLIST_URL);
    const auContent = await fetchPlaylist(AU_PLAYLIST_URL);
    console.log('✓ AU Playlist fetched successfully');
    
    console.log('Fetching UK playlist from:', UK_PLAYLIST_URL);
    const ukContent = await fetchPlaylist(UK_PLAYLIST_URL);
    console.log('✓ UK Playlist fetched successfully');
    
    // Parse all playlists
    const parseM3U = (content, source) => {
      const lines = content.split('\n');
      const streams = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // If line starts with #EXTINF, next non-empty line is the stream URL
        if (line.startsWith('#EXTINF:')) {
          const extinfLine = line;
          
          // Find the next non-empty, non-comment line (the stream URL)
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine && !nextLine.startsWith('#')) {
              streams.push({
                extinf: extinfLine,
                url: nextLine,
                source: source
              });
              break;
            }
          }
        }
      }
      return streams;
    };
    
    const nzStreams = parseM3U(nzContent, 'NZ');
    const auStreams = parseM3U(auContent, 'AU');
    const ukStreams = parseM3U(ukContent, 'UK');
    
    console.log(`\nFound ${nzStreams.length} NZ streams, ${auStreams.length} AU streams, and ${ukStreams.length} UK streams`);
    
    // Combine and deduplicate
    const allStreams = [...nzStreams, ...auStreams, ...ukStreams];
    const uniqueStreams = deduplicateChannels(allStreams);
    
    console.log(`✓ After deduplication: ${uniqueStreams.length} unique streams`);
    
    // Filter out unwanted channels
    const filteredStreams = filterUnwantedChannels(uniqueStreams);
    
    console.log(`✓ After filtering: ${filteredStreams.length} streams (removed ${uniqueStreams.length - filteredStreams.length} unwanted channels)`);
    
    // Load cache
    const cache = loadCache();
    
    console.log(`Checking which ones work (timeout: 5s per stream)...`);
    
    // Check streams in batches to avoid overwhelming the network
    const batchSize = 5;
    const results = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    
    for (let i = 0; i < filteredStreams.length; i += batchSize) {
      const batch = filteredStreams.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(stream => {
          if (cache[stream.url]) {
            cacheHits++;
            return Promise.resolve(cache[stream.url]);
          } else {
            cacheMisses++;
            return checkStream(stream.url).then(result => {
              // Add timestamp and save to cache
              result.timestamp = Date.now();
              cache[stream.url] = result;
              return result;
            });
          }
        })
      );
      results.push(...batchResults);
      
      const workingCount = results.filter(r => r.working).length;
      const failedCount = results.filter(r => !r.working).length;
      console.log(`Progress: ${results.length}/${filteredStreams.length} checked, ${workingCount} working, ${failedCount} failed (${cacheHits} cached, ${cacheMisses} new)`);
    }
    
    // Save updated cache
    saveCache(cache);
    
    console.log('\n✓ All streams checked, filtering results...');
    
    // Filter to only working streams
    const workingStreams = filteredStreams.filter((stream, idx) => results[idx].working);
    
    console.log(`✓ Stream check complete: ${workingStreams.length}/${filteredStreams.length} streams working`);
    console.log('Sorting channels...');
    
    // Sort channels
    const sortedStreams = sortChannels(workingStreams);
    console.log('✓ Channels sorted');
    console.log('Building M3U content...');
    
    // Rebuild M3U with only working streams
    let filteredM3u = '#EXTM3U\n\n';
    
    for (const stream of sortedStreams) {
      filteredM3u += stream.extinf + '\n';
      filteredM3u += stream.url + '\n\n';
    }
    
    console.log('✓ M3U content built');
    console.log('Ensuring public directory exists...');
    
    // Ensure public directory exists
    const publicDir = path.join(__dirname, '..', 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    console.log('Writing file...');
    
    // Write m3u file
    const filePath = path.join(publicDir, 'playlist.m3u');
    fs.writeFileSync(filePath, filteredM3u.trim() + '\n');
    
    console.log('✓ M3U playlist generated successfully at:', filePath);
    console.log(`✓ Total working channels: ${workingStreams.length}`);
    
  } catch (error) {
    console.error('Error generating playlist:', error.message);
    process.exit(1);
  }
}

generatePlaylist();
