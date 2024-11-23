const express = require("express");
const path = require("path");
const fs = require("fs");
const morgan = require("morgan");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb"); // MongoDB driver
const PropertiesReader = require("properties-reader");

// setup express
const app = express();

// setup morgan for log
app.use(morgan("short"));

// Parse incoming JSON data
app.use(express.json());

// setup cors
const corsOptions = {
    origin: [
        "https://qamar002-mdx.github.io", // Allow GitHub Pages origin
        "http://localhost:3000"          // Allow localhost during testing
    ],
    methods: ["GET", "POST", "PUT", "DELETE"], // HTTP methods allowed
    allowedHeaders: ["Content-Type", "Authorization"] // Headers allowed
};

app.use(cors(corsOptions));

// setup properties for properties files
// Reading MongoDB connection details from db.properties
const properties = PropertiesReader(path.join(__dirname, "conf", "db.properties"));
const dbConnectionString = properties.get("db.connectionString"); // MongoDB connection string
const dbName = properties.get("db.databaseName"); // Database name

// Logger Middleware
app.use((req, res, next) => {
    const log = `${new Date().toISOString()} - ${req.method} ${req.url}`;
    console.log(log);
    next();
});

// 'public' directory path for serving static files
const staticPath = path.join(__dirname, "public");
app.use(express.static(staticPath));

// route for serving the index.html file from public folder
app.get("/", (req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
});

// static File Middleware
app.use("/images", (req, res, next) => {
    const filePath = path.join(__dirname, "images", req.url);
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            return res.status(404).send("Image not found!");
        }
        res.sendFile(filePath);
    });
});

// MongoDB Connection
let db; // Global variable for the database
const client = new MongoClient(dbConnectionString);

// Connecting to MongoDB Atlas
client.connect()
    .then(() => {
        db = client.db(dbName); // Setting the database
        console.log(`Connected to MongoDB database: ${dbName}`);
    })
    .catch((error) => {
        console.error("Error connecting to MongoDB:", error);
    });

// API Routes

// ================ product =================
// GET route to fetch all products from the 'product' collection
app.get("/products", async (req, res) => {
    try {
        const products = await db.collection("products").find().toArray(); // Fetch all products
        res.json(products); // Send products as JSON
    } catch (error) {
        res.status(500).send("Error fetching products");
    }
});

// POST route to add a new product to the 'product' collection
app.post("/products", async (req, res) => {
    const newProduct = req.body; // New product details from request body
    try {
        const result = await db.collection("products").insertOne(newProduct); // Insert new product
        res.status(201).json({ success: true, productId: result.insertedId });
    } catch (error) {
        res.status(500).send("Error adding product");
    }
});

// PUT route to update an existing product in the 'product' collection
app.put("/products/:id", async (req, res) => {
    const productId = parseInt(req.params.id); // ID as integer
    const updatedData = req.body;

    try {
        const result = await db.collection("products").updateOne(
            { id: productId }, // Query using 'id'
            { $set: updatedData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).send("Product not found");
        }

        res.json({ success: true, message: "Product updated successfully" });
    } catch (error) {
        console.error("Error updating product:", error);
        res.status(500).send("Error updating product");
    }
});

// ================ Order =================
// GET route to fetch all orders
app.get("/orders", async (req, res) => {
    try {
        const orders = await db.collection("orders").find().toArray();
        res.json(orders);
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

app.post("/orders", async (req, res) => {
    const newOrder = req.body;

    // Validate order data
    if (!newOrder || !newOrder.productIDs || !newOrder.quantities || !newOrder.name || !newOrder.phone) {
        return res.status(400).json({ error: "Invalid order data. Fields 'productIDs', 'quantities', 'name', and 'phone' are required." });
    }

    try {
        const session = client.startSession(); // MongoDB transaction session
        session.startTransaction();

        const productsCollection = db.collection("products");
        const ordersCollection = db.collection("orders");

        // Loop through productIDs and quantities
        for (let i = 0; i < newOrder.productIDs.length; i++) {
            const productId = newOrder.productIDs[i];
            const orderedQuantity = newOrder.quantities[i];

            // Fetch product from DB
            const product = await productsCollection.findOne({ id: productId }, { session });

            if (!product) {
                await session.abortTransaction();
                session.endSession();
                return res.status(404).json({ error: `Product with ID ${productId} not found` });
            }

            // Check if sufficient inventory is available
            if (product.availableInventory < orderedQuantity) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ error: `Insufficient inventory for product ID ${productId}` });
            }

            // Update available inventory
            await productsCollection.updateOne(
                { id: productId },
                { $inc: { availableInventory: -orderedQuantity } },
                { session }
            );
        }

        // Save the order
        const result = await ordersCollection.insertOne(newOrder, { session });

        // Commit transaction
        await session.commitTransaction();
        session.endSession();

        res.status(201).json({ success: true, orderId: result.insertedId });
    } catch (error) {
        console.error("Error processing order:", error);
        res.status(500).json({ error: "Failed to process order" });
    }
});

// Search

// Search products route
app.get("/search", async (req, res) => {
    const query = req.query.q; // Search query from frontend

    if (!query) {
        return res.status(400).json({ error: "Search query is required" });
    }

    try {
        const results = await db.collection("products").find({ 
            $or: [
                { title: { $regex: query, $options: "i" } },              // Search in title
                { description: { $regex: query, $options: "i" } },       // Search in description
                { location: { $regex: query, $options: "i" } },          // Search in location
                { price: { $regex: query, $options: "i" } },             // Search in price (as string)
                { availableInventory: parseInt(query) }                  // Exact match for numeric inventory
            ]
        }).toArray();

        res.json(results); // Send search results
    } catch (error) {
        console.error("Error searching products:", error);
        res.status(500).json({ error: "Failed to search products" });
    }
});


// 404 handler for non-existent routes
app.use(function (req, res) {
    res.status(404).send("Page not found!");
});

// Server Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
