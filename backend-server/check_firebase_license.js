const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json'))
});
const db = admin.firestore();

async function checkLicense() {
  try {
    const doc = await db.collection('licenses').doc('sandy').get();
    if (doc.exists) {
      console.log('License doc data:', doc.data());
    } else {
      console.log('No license found for "sandy"');
    }
  } catch (error) {
    console.error('Error fetching license:', error);
  } finally {
    process.exit(0);
  }
}

checkLicense();
