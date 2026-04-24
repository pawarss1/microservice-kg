from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/notifications/send', methods=['POST'])
def send_notification():
    data = request.get_json()
    return jsonify({'sent': True, 'event': data.get('event')})

@app.route('/notifications/status', methods=['GET'])
def get_status():
    return jsonify({'status': 'healthy'})

if __name__ == '__main__':
    app.run(port=8002)
