const fs = require('fs');
const path = require('path');

// Sample M3U playlist content
const m3uContent = `#EXTM3U
#EXTINF:-1 tvg-id="channel1" tvg-name="Channel 1" tvg-logo="https://example.com/logo1.png" group-title="Entertainment",Channel 1
https://example.com/stream1.m3u8
#EXTINF:-1 tvg-id="channel2" tvg-name="Channel 2" tvg-logo="https://example.com/logo2.png" group-title="News",Channel 2
https://example.com/stream2.m3u8
#EXTINF:-1 tvg-id="channel3" tvg-name="Channel 3" tvg-logo="https://example.com/logo3.png" group-title="Sports",Channel 3
https://example.com/stream3.m3u8
`;

// Ensure public directory exists
const publicDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Write m3u file
const filePath = path.join(publicDir, 'playlist.m3u');
fs.writeFileSync(filePath, m3uContent);

console.log('✓ M3U playlist generated successfully at:', filePath);
