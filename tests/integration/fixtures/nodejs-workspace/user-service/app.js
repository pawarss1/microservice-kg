const express = require('express');

const app = express();
app.use(express.json());

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id, name: 'Alice' });
});

app.post('/users/verify', (req, res) => {
  res.json({ valid: true });
});

app.listen(process.env.PORT || 3000);
