const webpush = require("web-push");

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log("Add these to the Render environment for this client:");
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`);
console.log("WEB_PUSH_VAPID_SUBJECT=mailto:YOUR_EMAIL@example.com");
console.log("");
console.log("Keep WEB_PUSH_VAPID_PRIVATE_KEY secret. Generate one key pair per client deployment.");
