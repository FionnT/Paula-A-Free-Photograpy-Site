const server = require("express").Router()
const { v4: uuidv4 } = require("uuid")
const jsonParser = require("body-parser").json()
const textParser = require("body-parser").text({ type: "*/*" })
const stripe = require("stripe")(process.env.STRIPE_SERVER_SECRET)

const sendOrderEmails = require("../utilities/order-emailer")
const { StoreItems, Order } = require("../../models/index")

server.get("/store/items", (req, res) => {
  StoreItems.find({ isPublished: true }, (err, results) => {
    if (err) res.sendStatus(502)
    else res.json(results)
  })
})

server.post("/store/resume-order", jsonParser, (req, res) => {
  const { orderID } = req.body
  Order.findOne({ orderID, status: "pending" })
    .lean()
    .exec((err, result) => {
      if (err) res.sendStatus(500)
      if (result) res.json(result)
      else res.sendStatus(404)
    })
})

server.post("/store/paymentintent", jsonParser, async (req, res) => {
  StoreItems.find({}, async (err, results) => {
    if (err) res.sendStatus(500)
    else {
      const cart = req.body
      const threeDays = 1000 * 60 * 60 * 24 * 3 // Allows for retrying the order if payment failed
      const orderID = uuidv4()
      const purchase = {
        items: [],
        cost: 0
      }

      // 1. Populate purchase.items with each individual item, in each selected size
      // 2. Calculate purchase cost of items

      cart.items.forEach(item => {
        purchase.items.push({ UUID: item.UUID, size: item.size, amount: item.amount, image: item.image, type: item.type })
      })

      results.forEach(result => {
        purchase.items.forEach(item => {
          if (result.UUID === item.UUID) {
            const selected_size = result.sizes.filter(size => size.measurements === item.size)[0]
            purchase.cost += selected_size.cost * item.amount * 100
            item.name = result.name
            item.cost = selected_size.cost * item.amount // Add individual total cost of each size to the stored data
          }
        })
      })

      // Create Stripe payment intent based on calculated cost
      const paymentIntent = await stripe.paymentIntents
        .create({
          amount: purchase.cost,
          currency: "eur",
          metadata: {
            orderID: cart.orderID ? cart.orderID : orderID // Use existing, or create a new one
          }
        })
        .catch(err => {
          res.json({ error: err })
        })

      if (paymentIntent) {
        cart.items = purchase.items // Only store the ordered sizes, instead of all
        cart.purchaseCost = purchase.cost / 100
        cart.expireAt = Date.now() + threeDays

        // Only exists if we're resuming an order already attempted
        if (!cart.orderID) {
          cart.orderID = orderID
          const order = new Order(cart)
          order.save().then(res.json({ paymentIntent: paymentIntent.client_secret }).end())
        } else {
          delete cart._id
          Order.findOneAndUpdate({ orderID }, cart, (err, data) => {
            if (err) res.sendStatus(403)
            else res.json({ paymentIntent: paymentIntent.client_secret }).end()
          })
        }
      }
    }
  })
})

server.post("/store/confirm-order", textParser, async (req, res) => {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = req.headers["stripe-signature"]
  const body = req.body

  let event = null

  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret)
  } catch (err) {
    // invalid signature
    res.sendStatus(500).end()
    return
  }

  const orderID = event.data.object.metadata.orderID

  const saveOrderThroughFallback = (orderID, status) => {
    // Create and save a new order instead, old one will auto-expire
    Order.find({ orderID }, (err, data) => {
      if (err) {
        console.log(err)
        res.sendStatus(500)
      } else {
        // We don't need to disable expiry here, because we never set it
        // It only gets set when a placeholder order is created via payment intent route
        data.status = status
        const order = new Order(data)
        order.save().then(() => {
          sendOrderEmails(data.toObject(), true)
          res.sendStatus(200).end()
        })
      }
    })
  }

  switch (event["type"]) {
    case "payment_intent.succeeded":
      Order.findOne({ orderID }, (err, data) => {
        if (err) saveOrderThroughFallback(orderID, "pending")
        else if (data) {
          data.status = "pending"
          data.expireAt = ""
          data.save().then(() => {
            sendOrderEmails(data.toObject(), false) // Payment and record update succeeded
            res.sendStatus(200).end()
          })
        }
      })
      return
    case "charge.succeeded":
      Order.findOne({ orderID }, (err, data) => {
        if (err) saveOrderThroughFallback(orderID, "payed")
        else if (data) {
          data.status = "payed"
          data.chargeID = event.data.object.id
          data.expireAt = ""
          data.save().then(() => {
            sendOrderEmails(data.toObject(), true) // Payment and record update succeeded
            res.sendStatus(200).end()
          })
        }
      })
      return
    case "payment_intent.payment_failed" || "charge.failed":
      Order.findOne({ orderID }, (err, data) => {
        if (err) saveOrderThroughFallback(orderID, "failed")
        else if (data) {
          data.status = "failed"
          data.expireAt = ""
          data.save().then(() => {
            sendOrderEmails(data.toObject(), false) // Payment and record update succeeded
            res.sendStatus(200).end()
          })
        }
      })
      return
    default:
      res.sendStatus(202)
      return
  }
})

module.exports = server
