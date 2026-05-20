import express from 'express';
import { Kafka } from 'kafkajs';

const USER_CREATED_TOPIC = 'user.created';

const app = express();
const kafka = new Kafka({ brokers: ['localhost:9092'] });
const consumer = kafka.consumer({ groupId: 'notification-group' });

// HTTP routes
app.get('/notify', (req, res) => {
  res.json({ message: 'notified' });
});

app.post('/send', (req, res) => {
  res.json({ sent: true });
});

// Kafka consumer
async function run() {
  await consumer.connect();
  await consumer.subscribe({ topic: USER_CREATED_TOPIC });

  await consumer.run({
    eachMessage: async ({ message }) => {
      console.log('Received:', message.value?.toString());
    },
  });
}

run();
app.listen(3001);
