const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const NZ_PLAYLIST_URL = 'https://i.mjh.nz/nz/raw-tv.m3u8';

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

async function checkStream(url, timeout = 10000, redirectCount = 0) {
  const maxRedirects = 5;
  
  return new Promise((resolve) => {
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
        
        if (redirectCount >= maxRedirects) {
          resolve({
            url,
            working: false,
            error: 'Too many redirects'
          });
          return;
        }
        
        // Follow the redirect
        const redirectUrl = new URL(res.headers.location, url).href;
        checkStream(redirectUrl, timeout, redirectCount + 1).then(resolve);
        return;
      }
      
      let data = '';
      let bytesReceived = 0;
      const maxBytes = 4096; // Read first 4KB to validate
      
      // Check if status code indicates success
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        request.destroy();
        resolve({
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
        
        // For m3u8 files, check if it's a valid HLS playlist
        if (url.includes('.m3u8')) {
          const hasValidHLS = data.includes('#EXTM3U') || 
                             data.includes('#EXT-X-') ||
                             data.includes('.ts') ||
                             data.includes('.m3u8');
          
          if (!hasValidHLS) {
            resolve({
              url,
              working: false,
              error: 'Invalid HLS content'
            });
            return;
          }
        }
        
        // Check if we got any data
        if (bytesReceived === 0) {
          resolve({
            url,
            working: false,
            error: 'No data received'
          });
          return;
        }
        
        resolve({
          url,
          working: true,
          statusCode: res.statusCode,
          bytes: bytesReceived
        });
      });
      
      res.on('error', (err) => {
        request.destroy();
        resolve({
          url,
          working: false,
          error: err.message
        });
      });
    });
    
    request.on('error', (err) => {
      resolve({
        url,
        working: false,
        error: err.message
      });
    });
    
    request.on('timeout', () => {
      request.destroy();
      resolve({
        url,
        working: false,
        error: 'Timeout'
      });
    });
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
    const m3uContent = await fetchPlaylist(NZ_PLAYLIST_URL);
    
    console.log('✓ Playlist fetched successfully');
    
    // Parse M3U to extract stream URLs
    const lines = m3uContent.split('\n');
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
              url: nextLine
            });
            break;
          }
        }
      }
    }
    
    console.log(`\nFound ${streams.length} streams. Checking which ones work...`);
    
    // Check streams in batches to avoid overwhelming the network
    const batchSize = 10;
    const results = [];
    
    for (let i = 0; i < streams.length; i += batchSize) {
      const batch = streams.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(stream => checkStream(stream.url))
      );
      results.push(...batchResults);
      
      const workingCount = results.filter(r => r.working).length;
      console.log(`Progress: ${results.length}/${streams.length} checked, ${workingCount} working`);
    }
    
    // Filter to only working streams
    const workingStreams = streams.filter((stream, idx) => results[idx].working);
    
    console.log(`\n✓ Stream check complete: ${workingStreams.length}/${streams.length} streams working`);
    
    // Sort channels
    const sortedStreams = sortChannels(workingStreams);
    console.log('✓ Channels sorted');
    
    // Rebuild M3U with only working streams
    let filteredM3u = '#EXTM3U x-tvg-url="https://i.mjh.nz/nz/epg.xml.gz"\n\n';
    
    for (const stream of sortedStreams) {
      filteredM3u += stream.extinf + '\n';
      filteredM3u += stream.url + '\n\n';
    }
    
    // Ensure public directory exists
    const publicDir = path.join(__dirname, '..', 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
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
