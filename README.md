# AreaOffers

AreaOffers is a local resale website where the site admin posts offers and users can create accounts, browse nearby listings, message the seller, reserve offers, and report suspicious posts.

It includes:

- PostgreSQL storage
- secure accounts with bcrypt password hashing and sessions
- public offer browsing with search, category, price, location, and sort filters
- one admin account, with offer posting restricted to that admin
- image upload with Cloudinary support, plus local fallback for testing
- buyer/seller messaging with unread notifications
- reserve/order flow with optional Stripe checkout
- seller tracking updates and two-sided sale confirmation
- listing reports, admin overview, offer deletion, and user bans

## Run Locally

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```bash
DATABASE_URL=your_postgres_connection_string
SESSION_SECRET=a_long_random_secret
CLIENT_BASE_URL=http://localhost:3000
NODE_ENV=development
```

Start the site:

```bash
npm start
```

Open `http://localhost:3000`.

## Let People In Your Area See It

Deploy the repo to a host like Render, Railway, Fly.io, or another Node/Express host. The site needs a public URL, a PostgreSQL database, and these environment variables:

```bash
DATABASE_URL=your_postgres_connection_string
SESSION_SECRET=a_long_random_secret
CLIENT_BASE_URL=https://your-real-domain.com
NODE_ENV=production
```

`CLIENT_BASE_URL` must match the real URL so email verification and payment redirects work.

## Optional Services

Image uploads:

```bash
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Stripe checkout:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Email verification with Resend:

```bash
EMAIL_VERIFICATION_REQUIRED=true
EMAIL_FROM=AreaOffers <verify@your-domain.com>
RESEND_API_KEY=re_...
```

If `EMAIL_VERIFICATION_REQUIRED` is not true, users can message and reserve without email verification. This keeps local testing simple.

## Admin

Only one account can be admin. If `ADMIN_EMAIL` is set before registration, only that email can become the admin account. If `ADMIN_EMAIL` is blank, the first registered account becomes admin automatically.

Only admins can post offers. Admins can also view reports, open reported offers, view site stats, delete offers, ban users, and resolve reports.

## Production Notes

Before using this with real money or a real community, add clear marketplace rules, moderation policies, fraud checks, rate limiting, dispute handling, refund logic, and a security review.
