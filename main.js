// Load environment variables.
require('dotenv').config();

const fs = require('fs');
const nodemailer = require('nodemailer');
const yargs = require('yargs');
const csv = require('csv-parser');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Parse command-line arguments.
const argv = yargs
  .option('service', {
    alias: 's',
    description: 'Select the email service (gmail, yahoo, outlook, protonmail).',
    type: 'string',
    demandOption: true, // Required
  })
  .option('email', {
    description: 'A single email address to send to (optional)',
    type: 'string',
  })
  .option('targets', {
    alias: 't',
    description: 'Path to the recipient file (.txt, .csv, or .json)',
    type: 'string',
  })
  .option('sub', {
    alias: 'subject',
    description: 'Subject for the email.',
    type: 'string',
  })
  .option('m', {
    alias: 'message',
    description: 'Message to send (from command line).',
    type: 'string',
    demandOption: false, // Optional if using --message-file
  })
  .option('message-file', {
    description: 'Message file to send (either .txt or .html).',
    type: 'string',
    demandOption: false, // Optional if using -m
  })
  .option('spoof-name', {
    alias: 'n',
    description: 'Spoofed sender name',
    type: 'string',
    demandOption: false, // Optional
  })
  .option('proxy', {
    description: 'Proxy string (optional)',
    type: 'string',
  })
  .option('type', {
    description: 'Message type (html or text)',
    choices: ['html', 'text'],
    demandOption: true, // Required
  })
  .option('link', {
    description: 'Link to include in the email body (optional)',
    type: 'string',
  })
  .option('link-text', {
    description: 'Text to display for the link (optional)',
    type: 'string',
  })
  .option('attachment', {
    description: 'Path to a file to attach to the email (optional)',
    type: 'string',
  })
  .conflicts('email', 'targets') // Ensure only one of these options is used at a time
  .conflicts('m', 'message-file') // Ensure only one message source (command line or file) is used at a time
  .help()
  .alias('help', 'h')
  .argv;

const service = argv.service.toLowerCase();

// Create a transport object based on the email service.
let transporterOptions = {
  service: service,
  auth: {
    user: process.env.user, // Email from .env
    pass: process.env.pass, // App password from .env
  },
};

// If proxy is provided, set up the proxy agent
if (argv.proxy) {
  transporterOptions.proxy = argv.proxy;
  transporterOptions.agent = new SocksProxyAgent(argv.proxy);
}

let transporter = nodemailer.createTransport(transporterOptions);

// Function to detect the file type and send emails accordingly
async function sendEmails(targetFilePath, singleEmail, subject, message, isHtml) {
  let recipients = [];

  // Handle either single email or file with multiple recipients
  if (singleEmail) {
    recipients.push(singleEmail.trim());  // Single email address
  } else {
    const fileExtension = path.extname(targetFilePath);
    if (fileExtension === '.txt') {
      recipients = await readEmailsFromTxt(targetFilePath);
    } else if (fileExtension === '.csv') {
      recipients = await readEmailsFromCsv(targetFilePath);
    } else if (fileExtension === '.json') {
      recipients = await readEmailsFromJson(targetFilePath);
    } else {
      console.log('Unsupported file format. Please use .txt, .csv, or .json files.');
      return;
    }
  }

  for (let recipient of recipients) {
    await sendEmail(recipient.trim(), subject, message, isHtml);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await Promise.all(recipients.map((recipient) => sendEmail(recipient.trim(), subject, message, isHtml)));
}

// Handle .txt file (one email per line)
function readEmailsFromTxt(targetFilePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(targetFilePath, 'utf8', (err, data) => {
      if (err) {
        reject(`Error reading file: ${err}`);
      } else {
        const recipients = data.split('\n').filter(email => email.trim());
        resolve(recipients);
      }
    });
  });
}

// Handle .csv file
function readEmailsFromCsv(targetFilePath) {
  return new Promise((resolve, reject) => {
    const recipients = [];
    fs.createReadStream(targetFilePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.email) {
          recipients.push(row.email.trim());  // Assuming the CSV has a column 'email'
        }
      })
      .on('end', () => {
        resolve(recipients);
      })
      .on('error', (err) => {
        reject(`Error reading CSV file: ${err}`);
      });
  });
}

// Handle .json file
function readEmailsFromJson(targetFilePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(targetFilePath, 'utf8', (err, data) => {
      if (err) {
        reject(`Error reading file: ${err}`);
      } else {
        try {
          const recipients = JSON.parse(data).map(r => r.email.trim()).filter(Boolean);
          resolve(recipients);
        } catch (parseError) {
          reject(`Error parsing JSON: ${parseError}`);
        }
      }
    });
  });
}

// Function to send email to a recipient
async function sendEmail(to, subject, customMessage, isHtml) {
  let mailOptions = {
    from: `${argv.spoofName || 'Sender'} <${process.env.user}>`,  // Spoofed sender name, actual email from environment variable
    to: to,
    subject: subject,
    text: isHtml ? null : customMessage,  // If not HTML, use plain text
    html: isHtml ? customMessage : null,   // If HTML, use this
    attachments: [] // Initialize attachments
  };

  // Add link to message if provided
  if (argv.link) {
    const displayText = argv['link-text'] || argv.link; // Use provided link text or default to the URL
    const linkMessage = isHtml ? 
      `<p>${customMessage}</p><p>Link: <a href="${argv.link}">${displayText}</a></p>` : 
      `${customMessage}\nLink: ${argv.link}`;
    
    mailOptions.html = isHtml ? linkMessage : null; // Override HTML message with link
    mailOptions.text = isHtml ? null : linkMessage; // Override text message with link
  }

  // Add file attachment if provided
  if (argv.attachment) {
    mailOptions.attachments.push({
      path: argv.attachment // Add attachment path from command line
    });
  }

  try {
    await transporter.sendMail(mailOptions);
    console.log('Email sent to:', to);
  } catch (error) {
    console.error('Error sending email to', to, ':', error.message);
  }
}

// Use the message directly from the command line, or read the file if provided.
const message = argv.m || null;
const isHtml = argv.type === 'html';

if (message) {
  // If message is provided from the command line, send directly
  sendEmails(argv.targets, argv.email, argv.subject, message, isHtml);
} else if (argv['message-file']) {
  // If message-file is provided, read it first
  const messageFilePath = path.resolve(argv['message-file']); // Ensure the path is resolved
  fs.readFile(messageFilePath, 'utf8', async (err, messageFileContent) => {
    if (err) {
      console.error('Error reading message file:', err);
      process.exit(1);
    } else {
      // Call the function to send emails with the content from the file
      await sendEmails(argv.targets, argv.email, argv.subject, messageFileContent, isHtml);
    }
  });
} else {
  console.error('Error: Please provide a message with -m or use --message-file.');
  process.exit(1);
}