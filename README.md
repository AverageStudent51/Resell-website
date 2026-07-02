# AreaOffers

AreaOffers is a local resale website where users can create accounts, post offers, browse nearby listings, message sellers, reserve offers, upload images, and report suspicious posts.

It includes:

- PostgreSQL storage
- secure accounts with bcrypt password hashing and sessions
- public offer browsing with search, category, price, location, and sort filters
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

If `EMAIL_VERIFICATION_REQUIRED` is not true, users can post, message, and reserve without email verification. This keeps local testing simple.

## Admin

The first registered account becomes admin automatically. You can also set `ADMIN_EMAIL` before registering to make a specific email admin.

Admins can view reports, open reported offers, view site stats, delete offers, ban sellers, and resolve reports.

## Production Notes

Before using this with real money or a real community, add clear marketplace rules, moderation policies, fraud checks, rate limiting, dispute handling, refund logic, and a security review.
