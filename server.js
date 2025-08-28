// server.js - Node.js backend for Todo Calendar App
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME;

// Google OAuth client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'your-google-client-id.apps.googleusercontent.com';
console.log('Backend using Google Client ID:', GOOGLE_CLIENT_ID);
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

let db;
let tasksCollection;
let usersCollection;

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'https://todo-calender.up.railway.app', 'https://todo-calender-be-production.up.railway.app'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json());

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI, {
      tls: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
      minPoolSize: 5,
      maxIdleTimeMS: 30000,
      retryWrites: true,
      writeConcern: { w: 'majority' }
    });
    await client.connect();
    console.log('Connected to MongoDB successfully');
    
    db = client.db(DB_NAME);
    tasksCollection = db.collection(COLLECTION_NAME);
    usersCollection = db.collection('users');
    
    // Create indexes for better performance
    await tasksCollection.createIndex({ dateKey: 1, userId: 1 });
    await tasksCollection.createIndex({ "task.id": 1, userId: 1 });
    await tasksCollection.createIndex({ userId: 1 });
    await usersCollection.createIndex({ userId: 1 }, { unique: true });
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
  }
}

// Helper function to download and store user profile image
async function downloadAndStoreImage(imageUrl, userId) {
  return new Promise((resolve, reject) => {
    if (!imageUrl) {
      console.log('No image URL provided for user:', userId);
      resolve(null);
      return;
    }

    console.log('Downloading image for user:', userId, 'from:', imageUrl);
    
    https.get(imageUrl, (response) => {
      if (response.statusCode !== 200) {
        console.error('Failed to download image:', response.statusCode, 'for user:', userId);
        resolve(null);
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const imageBuffer = Buffer.concat(chunks);
          const imageHash = crypto.createHash('md5').update(imageBuffer).digest('hex');
          
          console.log('Image downloaded successfully for user:', userId, 'Size:', imageBuffer.length, 'bytes');
          
          resolve({
            data: imageBuffer,
            contentType: response.headers['content-type'] || 'image/jpeg',
            hash: imageHash,
            size: imageBuffer.length
          });
        } catch (error) {
          console.error('Error processing image for user:', userId, error);
          resolve(null);
        }
      });
    }).on('error', (error) => {
      console.error('Error downloading image for user:', userId, error);
      resolve(null);
    });
  });
}

// Helper function to get or create user profile
async function getOrCreateUserProfile(userPayload) {
  try {
    const userId = userPayload.sub;
    let userProfile = await usersCollection.findOne({ userId });

    if (!userProfile) {
      // New user - download and store profile image
      console.log('Creating new user profile for:', userPayload.email);
      
      const imageData = await downloadAndStoreImage(userPayload.picture, userId);
      
      userProfile = {
        userId,
        email: userPayload.email,
        name: userPayload.name,
        profileImage: imageData,
        googlePictureUrl: userPayload.picture,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await usersCollection.insertOne(userProfile);
      console.log('User profile created successfully');
    } else {
      // Existing user - check if we need to update the profile image
      const shouldUpdateImage = !userProfile.profileImage || 
                               userProfile.googlePictureUrl !== userPayload.picture;

      if (shouldUpdateImage && userPayload.picture) {
        console.log('Updating profile image for user:', userPayload.email);
        
        const imageData = await downloadAndStoreImage(userPayload.picture, userId);
        
        await usersCollection.updateOne(
          { userId },
          {
            $set: {
              name: userPayload.name,
              email: userPayload.email,
              profileImage: imageData,
              googlePictureUrl: userPayload.picture,
              updatedAt: new Date()
            }
          }
        );
        
        userProfile.profileImage = imageData;
        console.log('Profile image updated successfully');
      }
    }

    return userProfile;
  } catch (error) {
    console.error('Error managing user profile:', error);
    return null;
  }
}

// Authentication middleware
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Verify Google JWT token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    
    // Get or create user profile with stored image
    const userProfile = await getOrCreateUserProfile(payload);
    
    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: userProfile?.profileImage ? `/api/user/image/${userProfile.userId}` : payload.picture,
      hasStoredImage: !!userProfile?.profileImage
    };
    
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Routes

// GET /api/tasks - Get all tasks for authenticated user
app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const tasks = await tasksCollection.find({ userId }).toArray();
    
    // Transform MongoDB documents back to the app's expected format
    const tasksObject = {};
    tasks.forEach(doc => {
      if (!tasksObject[doc.dateKey]) {
        tasksObject[doc.dateKey] = [];
      }
      tasksObject[doc.dateKey].push(doc.task);
    });
    
    // Get completions for this user
    const completionsDoc = await db.collection('completions').findOne({ 
      type: 'completions',
      userId 
    });
    if (completionsDoc) {
      tasksObject.completions = completionsDoc.data;
    }
    
    res.json(tasksObject);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// POST /api/tasks - Save a new task for authenticated user
app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const { dateKey, task } = req.body;
    const userId = req.user.id;
    
    if (!dateKey || !task) {
      return res.status(400).json({ error: 'dateKey and task are required' });
    }
    
    const document = {
      userId,
      dateKey,
      task,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const result = await tasksCollection.insertOne(document);
    
    res.json({ 
      success: true, 
      id: result.insertedId,
      message: 'Task saved successfully' 
    });
  } catch (error) {
    console.error('Error saving task:', error);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

// PUT /api/tasks - Update an existing task for authenticated user
app.put('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const { dateKey, taskIndex, task } = req.body;
    const userId = req.user.id;
    
    if (!dateKey || taskIndex === undefined || !task) {
      return res.status(400).json({ error: 'dateKey, taskIndex, and task are required' });
    }
    
    // Find the task to update by dateKey, task ID, and userId
    const existingDoc = await tasksCollection.findOne({
      userId,
      dateKey,
      'task.id': task.id
    });
    
    if (!existingDoc) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    // Update the task
    const result = await tasksCollection.updateOne(
      { _id: existingDoc._id },
      { 
        $set: { 
          task,
          updatedAt: new Date()
        } 
      }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    res.json({ 
      success: true, 
      message: 'Task updated successfully' 
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /api/tasks - Delete a task for authenticated user
app.delete('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const { dateKey, taskIndex } = req.body;
    const userId = req.user.id;
    
    if (!dateKey || taskIndex === undefined) {
      return res.status(400).json({ error: 'dateKey and taskIndex are required' });
    }
    
    // Get all tasks for the date and user
    const tasksForDate = await tasksCollection.find({ userId, dateKey }).sort({ 'task.id': 1 }).toArray();
    
    if (taskIndex >= tasksForDate.length) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const taskToDelete = tasksForDate[taskIndex];
    
    const result = await tasksCollection.deleteOne({ _id: taskToDelete._id });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    res.json({ 
      success: true, 
      message: 'Task deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// POST /api/completions - Update task completions for authenticated user
app.post('/api/completions', authenticateToken, async (req, res) => {
  try {
    const { completions } = req.body;
    const userId = req.user.id;
    
    if (!completions) {
      return res.status(400).json({ error: 'completions data is required' });
    }
    
    // Upsert completions document for this user
    await db.collection('completions').updateOne(
      { type: 'completions', userId },
      { 
        $set: { 
          data: completions,
          updatedAt: new Date()
        } 
      },
      { upsert: true }
    );
    
    res.json({ 
      success: true, 
      message: 'Completions updated successfully' 
    });
  } catch (error) {
    console.error('Error updating completions:', error);
    res.status(500).json({ error: 'Failed to update completions' });
  }
});

// POST /api/auth/verify - Verify user token and get user info
app.post('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error('Error verifying user:', error);
    res.status(500).json({ error: 'Failed to verify user' });
  }
});

// GET /api/user/image/:userId - Serve user profile image
app.get('/api/user/image/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log('Serving image for user:', userId);
    console.log('Database name:', DB_NAME);
    console.log('Users collection initialized:', !!usersCollection);
    
    // Debug: List all users in collection
    const allUsers = await usersCollection.find({}).toArray();
    console.log('All users in collection:', allUsers.length);
    allUsers.forEach(user => {
      console.log('User ID in DB:', user.userId, 'Has image:', !!user.profileImage);
    });
    
    const userProfile = await usersCollection.findOne({ userId });
    
    if (!userProfile) {
      console.log('User profile not found for:', userId);
      return res.status(404).json({ error: 'User profile not found' });
    }
    
    if (!userProfile.profileImage) {
      console.log('Profile image not found for user:', userId);
      return res.status(404).json({ error: 'Profile image not found' });
    }
    
    const { data, contentType } = userProfile.profileImage;
    
    // Handle MongoDB Binary data
    const imageBuffer = data.buffer ? Buffer.from(data.buffer) : data;
    
    console.log('Serving image for user:', userId, 'Size:', imageBuffer.length, 'Type:', contentType);
    
    res.set({
      'Content-Type': contentType,
      'Content-Length': imageBuffer.length,
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      'ETag': userProfile.profileImage.hash
    });
    
    res.send(imageBuffer);
  } catch (error) {
    console.error('Error serving profile image:', error);
    res.status(500).json({ error: 'Failed to serve profile image' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
  await connectToMongoDB();
  
  app.listen(PORT, () => {
    console.log(`Todo Calendar API server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = app;