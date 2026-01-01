const express = require('express');
const path = require('path');
const fs = require('fs');

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

// Dynamic EPG XML route
app.get('/epg.xml', (req, res) => {
  const currentDate = new Date().toISOString();
  
  // Generate EPG XML dynamically
  const epgXml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="TV EPG" generator-info-url="/">
  <channel id="channel1">
    <display-name>Channel 1</display-name>
  </channel>
  <programme start="${currentDate}" stop="${currentDate}" channel="channel1">
    <title lang="en">Sample Program</title>
    <desc lang="en">This is a sample EPG entry</desc>
  </programme>
</tv>`;

  res.setHeader('Content-Type', 'application/xml');
  res.send(epgXml);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'TV App is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
