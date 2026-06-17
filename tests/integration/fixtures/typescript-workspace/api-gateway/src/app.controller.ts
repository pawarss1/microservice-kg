import axios from 'axios';
import { Kafka } from 'kafkajs';
import { Controller, Get, Post } from '@nestjs/common';
import { Client, ClientKafka, MessagePattern } from '@nestjs/microservices';

const USER_CREATED_TOPIC = 'user.created';

const kafka = new Kafka({ brokers: ['localhost:9092'] });
const producer = kafka.producer();

@Controller('/api')
export class AppController {
  @Get('/health')
  async healthCheck() {
    return { status: 'ok' };
  }

  @Post('/users')
  async createUser() {
    // Call notification service
    const response = await axios.get('http://notification-service/notify');

    // Publish event to Kafka
    await producer.connect();
    await producer.send({
      topic: USER_CREATED_TOPIC,
      messages: [{ value: JSON.stringify({ event: 'user.created' }) }],
    });

    return response.data;
  }

  @Get('/orders')
  async listOrders() {
    const url = 'http://notification-service/send';
    const result = await axios.post(url);
    return result.data;
  }
}
