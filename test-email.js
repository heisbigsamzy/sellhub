const { sendOTPEmail } = require('./mailer');

sendOTPEmail('heisbigsamzy@gmail.com', '123456')
  .then(() => console.log('✅ Email sent! Check your inbox.'))
  .catch(err => console.log('❌ Failed:', err.message));