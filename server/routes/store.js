const { v4: uuidv4 } = require("uuid")
const server = require("express").Router()
const jsonParser = require("body-parser").json()
const textParser = require("body-parser").text({ type: "*/*" })
const busboy = require("connect-busboy")()
const stripe = require("stripe")(process.env.STRIPE_SERVER_SECRET)

const sendOrderEmails = require("./utilities/order-emailer")
const privileged = require("./middleware/privileged")
const authenticated = require("./middleware/authenticated")()
const { StoreItems, Order } = require("../models/index")

server.get("/store/items", (req, res) => {
  StoreItems.find({ isPublished: true }, (err, results) => {
    if (err) res.sendStatus(502)
    else res.json(results)
  })
})

//, authenticated, privileged(2)
server.post("/store/upload/json", jsonParser, (req, res) => {
  return new Promise(resolve => {
    const StoreItem = new StoreItems(req.body)
    const extLocation = req.body.image.split(".").length - 1
    const extension = req.body.image.split(".")[extLocation]
    StoreItem.UUID = "893effd5-2043-46e3-9fe6-59a9b3f17044"
    StoreItem.image = StoreItem.UUID + "." + extension
    StoreItem.save()
      .then(res.json({ UUID: StoreItem.UUID }))
      .then(resolve())
  })
})

server.post("/store/upload/update", jsonParser, (req, res) => {
  return new Promise(resolve => {
    StoreItems.findOne({ UUID: req.body.UUID }, (err, result) => {
      if (err) res.sendStatus(500)
      if (result) {
        Object.assign(result, req.body)
        result.save().then(res.sendStatus(200)).then(resolve())
      } else res.sendStatus(403)
    })
  })
})

server.post("/store/resume-order", jsonParser, (req, res) => {
  const { orderID } = req.body
  Order.findOne({ orderID }, (err, result) => {
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
        purchase.items.push({ UUID: item.UUID, size: item.size, amount: item.amount, image: item.image })
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
            orderID: orderID
          }
        })
        .catch(err => {
          res.json({ error: err })
        })
      if (paymentIntent) {
        cart.orderID = orderID
        cart.items = purchase.items // Only store the ordered sizes, instead of all
        cart.purchaseCost = purchase.cost / 100
        cart.expireAt = Date.now() + threeDays

        const order = new Order(cart)
        order.save().then(res.json({ paymentIntent: paymentIntent.client_secret }).end())
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

  const saveOrderThroughFallback = orderID => {
    // Create and save a new order instead, old one will auto-expire
    Order.find({ orderID })
      .lean()
      .exec((err, data) => {
        if (err) {
          console.log(err)
          sendOrderEmails(data, "payed")
          res.sendStatus(500)
        } else {
          const order = new Order(data)
          order.save().then(() => {
            sendOrderEmails(data, "payed")
            res.sendStatus(200).end()
          })
        }
      })
  }

  // eslint-disable-next-line default-case
  switch (event["type"]) {
    case "payment_intent.succeeded":
      const orderID = event.data.object.metadata.orderID
      Order.findOneAndUpdate({ orderID }, { $unset: { expireAt: "" } }, (err, data) => {
        if (err) saveOrderThroughFallback(orderID)
        else {
          sendOrderEmails(data, "payed") // Payment and record update succeeded
          res.sendStatus(200).end()
        }
      })
      return
    case "payment_intent.payment_failed":
      Order.findOne({ orderID })
        .lean()
        .exec((err, data) => {
          if (err) res.sendStatus(500)
          else {
            sendOrderEmails(data, "failed") // Payment failed
          }
        })
  }
})

module.exports = server
