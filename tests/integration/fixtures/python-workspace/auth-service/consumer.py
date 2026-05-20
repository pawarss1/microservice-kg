from confluent_kafka import Consumer

EMAIL_TOPIC = "auth_events"
STATUS_TOPIC = "auth_status"

config = {"bootstrap.servers": "localhost:9092", "group.id": "auth-consumer"}
consumer = Consumer(config)
consumer.subscribe([EMAIL_TOPIC])
