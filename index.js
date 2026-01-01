const express = require('express');
const path = require('path');
const fs = require('fs');
// const https = require('https');
// const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static m3u file
app.get('/playlist.m3u', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'playlist.m3u');
  
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Playlist not found');
  }
});

// // Dynamic EPG XML route
// app.get('/epg.xml', (req, res) => {
//   const epgUrl = 'https://i.mjh.nz/nz/epg.xml.gz';
  
//   https.get(epgUrl, (response) => {
//     if (response.statusCode !== 200) {
//       return res.status(response.statusCode).send('Failed to fetch EPG');
//     }
    
//     res.setHeader('Content-Type', 'application/xml');
    
//     // Decompress the gzipped content and pipe to response
//     response.pipe(zlib.createGunzip()).pipe(res);
//   }).on('error', (err) => {
//     console.error('Error fetching EPG:', err);
//     res.status(500).send('Error fetching EPG');
//   });
// });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'TV App is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
