require('dotenv').config();
const { App } = require('@slack/bolt');
const WebSocket = require('ws');
const crypto = require('crypto');

// Initialize your app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Function to generate a unique session ID
const generateSessionId = () => {
  return crypto.randomUUID();
};

// Function to handle WebSocket connection
const connectToBackend = async (userMessage, say) => {
  const sessionId = generateSessionId();
  const ws = new WebSocket(`${process.env.BACKEND_WS_URL}/${sessionId}`);
  
  let currentMessage = null;

  return new Promise((resolve, reject) => {
    let isConnected = false;
    let messageContent = '';
    
    ws.on('open', async () => {
      console.log('Connected to backend WebSocket');
      
      // Send initial thinking message
      currentMessage = await say({
        text: "🤔 Thinking...",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🤔 Thinking..."
            }
          }
        ]
      });
    });

    ws.on('message', async (data) => {
      try {
        const message = data.toString();
        console.log('Raw WebSocket message:', message);

        // Parse the message
        const jsonMessage = JSON.parse(message);
        console.log('Parsed message:', jsonMessage);

        // Wait for connection confirmation before sending the actual message
        if (jsonMessage.content?.includes('Connected to ANA Multi-Agent')) {
          console.log('Received connection confirmation, sending message...');
          isConnected = true;
          
          // Format message as JSON with proper structure
          const messagePayload = {
            type: "chat",
            content: userMessage
          };

          // Send the JSON message
          console.log('Sending message payload:', messagePayload);
          ws.send(JSON.stringify(messagePayload));
          return;
        }

        // Handle error messages
        if (jsonMessage.type === 'error') {
          console.error('WebSocket error message:', jsonMessage.error);
          if (currentMessage) {
            await app.client.chat.update({
              channel: currentMessage.channel,
              ts: currentMessage.ts,
              text: `❌ Error: ${jsonMessage.error}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `❌ Error: ${jsonMessage.error}`
                  }
                }
              ]
            });
          }
          return;
        }

        let lastUpdateTime = 0;
        const updateInterval = 1000; // Update every 1 second

        // Handle streaming responses
        if (jsonMessage.type === 'stream_chunk' && jsonMessage.content) {
          messageContent += jsonMessage.content;
          
          // Update the message in Slack with rate limiting
          if (currentMessage) {
            const now = Date.now();
            if (now - lastUpdateTime >= updateInterval) {
              try {
                await app.client.chat.update({
                  channel: currentMessage.channel,
                  ts: currentMessage.ts,
                  text: messageContent,
                  blocks: [
                    {
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: messageContent
                      }
                    }
                  ]
                });
                lastUpdateTime = now;
              } catch (updateError) {
                if (updateError.code === 'rate_limited') {
                  const retryAfter = parseInt(updateError.retryAfter) || 1;
                  await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                } else {
                  console.error('Error updating message:', updateError);
                }
              }
            }
          }
        }

        // Handle stream completion
        if (jsonMessage.type === 'stream_complete') {
          console.log('Stream completed');
        }
      } catch (error) {
        console.error('Error handling message:', error);
      }
    });

    ws.on('error', async (error) => {
      console.error('WebSocket error:', error);
      if (currentMessage) {
        try {
          await app.client.chat.update({
            channel: currentMessage.channel,
            ts: currentMessage.ts,
            text: "❌ Sorry, there was an error processing your request.",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "❌ Sorry, there was an error processing your request."
                }
              }
            ]
          });
        } catch (updateError) {
          console.error('Error updating error message:', updateError);
        }
      }
      reject(error);
    });

    ws.on('close', () => {
      console.log('Backend WebSocket connection closed');
      resolve();
    });

    // Set a timeout to close the connection if no response
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 30000); // 30 seconds timeout
  });
};

// Handle direct messages and channel messages
app.message(async ({ message, say }) => {
  try {
    // Ignore messages from the bot itself or if message is undefined
    if (!message?.text || message.subtype === 'bot_message') return;

    console.log('Received message:', message.text);
    
    // If message is just "hello", respond with greeting
    if (message.text.toLowerCase().trim() === 'hello') {
      await say({
        text: `Hey there <@${message.user}>! 👋\nI'm your DevOps assistant. How can I help you today?`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Hey there <@${message.user}>! 👋\nI'm your DevOps assistant. How can I help you today?`
            }
          }
        ]
      });
      return;
    }

    // For all other messages, connect to backend WebSocket
    await connectToBackend(message.text, say);

  } catch (error) {
    console.error('Error in message handler:', error);
    await say({
      text: 'Sorry, there was an error processing your message.',
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "❌ Sorry, there was an error processing your message."
          }
        }
      ]
    });
  }
});

// Handle app mentions
app.event('app_mention', async ({ event, say }) => {
  try {
    console.log('Received mention:', event);
    
    // Extract the actual message (remove the bot mention)
    const message = event.text.replace(/<@[A-Z0-9]+>/, '').trim();
    
    if (!message) {
      await say({
        text: `Hi <@${event.user}>! How can I help you?`,
        thread_ts: event.thread_ts || event.ts,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Hi <@${event.user}>! How can I help you?`
            }
          }
        ]
      });
      return;
    }

    // Connect to backend WebSocket
    await connectToBackend(message, say);

  } catch (error) {
    console.error('Error in app_mention handler:', error);
    await say({
      text: 'Sorry, there was an error processing your mention.',
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "❌ Sorry, there was an error processing your mention."
          }
        }
      ]
    });
  }
});

// Start the app
(async () => {
  try {
    console.log('Starting app...');
    await app.start();
    console.log('⚡️ Bolt app is running!');
  } catch (error) {
    console.error('❌ Error starting app:', error);
    if (error.data) {
      console.error('Error details:', JSON.stringify(error.data, null, 2));
    }
  }
})();

// Global error handlers
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});