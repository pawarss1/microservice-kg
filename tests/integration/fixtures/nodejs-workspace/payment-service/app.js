const express = require('express');
const axios = require('axios');

const app = express();
const USER_SERVICE = process.env.USER_SERVICE_URL || 'http://user-service:3000';

app.get('/payments/:id', async (req, res) => {
  const user = await axios.get(`${USER_SERVICE}/users/${req.params.id}`);
  res.json({ payment: req.params.id, user: user.data });
});

app.post('/payments', async (req, res) => {
  const verified = await axios.post(`${USER_SERVICE}/users/verify`, req.body);
  res.json({ status: 'created' });
});

app.listen(process.env.PORT || 3001);
