-- PG Studio demo database: a fake bookshop with ~430k rows.
-- Loaded automatically by demo/docker-compose.yml (docker-entrypoint-initdb.d).
-- All names, emails and numbers are generated. Deterministic via setseed().
SELECT setseed(0.42);

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'refunded');

CREATE TABLE authors (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  country     text,
  born        date
);
COMMENT ON TABLE authors IS 'Book authors';

CREATE TABLE books (
  id           serial PRIMARY KEY,
  author_id    int NOT NULL REFERENCES authors(id),
  title        text NOT NULL,
  isbn         text UNIQUE,
  genre        text NOT NULL,
  price_cents  int NOT NULL CHECK (price_cents >= 0),
  published_on date,
  metadata     jsonb
);
CREATE INDEX books_author_idx ON books(author_id);
COMMENT ON COLUMN books.price_cents IS 'List price in cents';

CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  full_name   text NOT NULL,
  city        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES customers(id),
  status       order_status NOT NULL DEFAULT 'pending',
  total_cents  int NOT NULL,
  placed_at    timestamptz NOT NULL,
  notes        text
);
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_placed_at_idx ON orders(placed_at);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_id    int    NOT NULL REFERENCES books(id),
  quantity   int    NOT NULL CHECK (quantity > 0),
  unit_cents int    NOT NULL,
  PRIMARY KEY (order_id, book_id)
);

CREATE TABLE reviews (
  id          bigserial PRIMARY KEY,
  book_id     int NOT NULL REFERENCES books(id),
  customer_id bigint NOT NULL REFERENCES customers(id),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text,
  created_at  timestamptz NOT NULL
);

-- authors
INSERT INTO authors (name, country, born)
SELECT f || ' ' || l,
       (ARRAY['UK','US','India','Japan','Brazil','Nigeria','France','Canada','Germany','Kenya'])[1 + (g % 10)],
       date '1940-01-01' + (random() * 20000)::int
FROM generate_series(1, 400) g,
     LATERAL (SELECT (ARRAY['Ada','Ravi','Mei','Lena','Tomas','Amara','Noah','Priya','Hugo','Yuki','Sofia','Kwame','Ines','Arjun','Clara','Omar'])[1 + (g % 16)] AS f,
                     (ARRAY['Hart','Iyer','Okafor','Novak','Silva','Tanaka','Moreau','Chen','Byrne','Haddad','Kowalski','Mensah','Reyes','Lindqvist'])[1 + ((g * 7) % 14)] AS l) n;

-- books
INSERT INTO books (author_id, title, isbn, genre, price_cents, published_on, metadata)
SELECT 1 + (g % 400),
       (ARRAY['The','A','Beyond the','Under the','Letters from the','Notes on the','Return of the','Songs of the'])[1 + (g % 8)] || ' ' ||
       (ARRAY['Silent','Copper','Northern','Hidden','Last','Paper','Glass','Winter','Salt','Distant','Quiet','Burning'])[1 + ((g * 3) % 12)] || ' ' ||
       (ARRAY['Harbor','Garden','Algorithm','River','Archive','Lighthouse','Orchard','Index','Kingdom','Signal'])[1 + ((g * 5) % 10)],
       '978' || lpad((1000000000 + g * 7919)::text, 10, '0'),
       (ARRAY['Fiction','Mystery','Sci-Fi','History','Poetry','Biography','Tech','Fantasy'])[1 + ((g * 11) % 8)],
       499 + (random() * 4000)::int,
       date '1980-01-01' + (random() * 16000)::int,
       jsonb_build_object('pages', 120 + (random() * 600)::int,
                          'format', (ARRAY['hardcover','paperback','ebook'])[1 + (g % 3)],
                          'tags', jsonb_build_array((ARRAY['award-winner','staff-pick','new','classic'])[1 + (g % 4)]))
FROM generate_series(1, 3000) g;

-- customers
INSERT INTO customers (email, full_name, city, created_at)
SELECT 'reader' || g || '@example.com',
       (ARRAY['Ada','Ravi','Mei','Lena','Tomas','Amara','Noah','Priya','Hugo','Yuki','Sofia','Kwame'])[1 + (g % 12)] || ' ' ||
       (ARRAY['Hart','Iyer','Okafor','Novak','Silva','Tanaka','Moreau','Chen','Byrne','Haddad'])[1 + ((g * 7) % 10)],
       (ARRAY['London','Pune','Lagos','Lisbon','Osaka','Toronto','Berlin','Nairobi','Austin','Lyon'])[1 + ((g * 3) % 10)],
       timestamptz '2022-01-01' + random() * interval '1000 days'
FROM generate_series(1, 25000) g;

-- orders
INSERT INTO orders (customer_id, status, total_cents, placed_at, notes)
SELECT 1 + (random() * 24999)::int,
       (ARRAY['pending','paid','shipped','delivered','delivered','delivered','refunded']::order_status[])[1 + (g % 7)],
       0,
       timestamptz '2023-01-01' + random() * interval '650 days',
       CASE WHEN g % 9 = 0 THEN 'Gift wrap, please' WHEN g % 13 = 0 THEN 'Leave at the front desk' END
FROM generate_series(1, 120000) g;

-- order items (1-3 per order)
INSERT INTO order_items (order_id, book_id, quantity, unit_cents)
SELECT o.id, b.book_id, 1 + (random() * 2)::int, bk.price_cents
FROM orders o
CROSS JOIN LATERAL (
  SELECT DISTINCT 1 + ((o.id * k * 2654435761) % 3000)::int AS book_id
  FROM generate_series(1, 1 + (o.id % 3)::int) k
) b
JOIN books bk ON bk.id = b.book_id;

UPDATE orders o SET total_cents = s.t
FROM (SELECT order_id, sum(quantity * unit_cents) t FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

-- reviews
INSERT INTO reviews (book_id, customer_id, rating, body, created_at)
SELECT 1 + (random() * 2999)::int,
       1 + (random() * 24999)::int,
       1 + (random() * 4)::int,
       (ARRAY['Could not put it down.','Slow start, great ending.','Beautifully written.','Not for me.','Read it twice!', NULL])[1 + (g % 6)],
       timestamptz '2023-02-01' + random() * interval '600 days'
FROM generate_series(1, 40000) g;

-- view + materialized view
CREATE VIEW recent_orders AS
SELECT o.id, c.full_name, c.email, o.status, o.total_cents, o.placed_at
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.placed_at > timestamptz '2024-06-01';

CREATE MATERIALIZED VIEW book_sales AS
SELECT b.id AS book_id, b.title, a.name AS author, sum(oi.quantity) AS copies_sold,
       sum(oi.quantity * oi.unit_cents) AS revenue_cents
FROM order_items oi JOIN books b ON b.id = oi.book_id JOIN authors a ON a.id = b.author_id
GROUP BY b.id, b.title, a.name;

-- functions and procedures
CREATE FUNCTION book_rating(p_book_id int) RETURNS numeric
LANGUAGE sql STABLE
AS $$
  SELECT round(avg(rating), 2) FROM reviews WHERE book_id = p_book_id;
$$;
COMMENT ON FUNCTION book_rating(int) IS 'Average review rating (1-5) for a book, or NULL if unreviewed';

CREATE FUNCTION top_books_by_revenue(p_limit int DEFAULT 10)
RETURNS TABLE (book_id int, title text, revenue_cents bigint)
LANGUAGE plpgsql STABLE ROWS 10
AS $$
BEGIN
  RETURN QUERY
    SELECT s.book_id, s.title, s.revenue_cents::bigint
      FROM book_sales s
     ORDER BY s.revenue_cents DESC
     LIMIT p_limit;
END;
$$;
COMMENT ON FUNCTION top_books_by_revenue(int) IS 'Best sellers by revenue, from the book_sales materialized view';

-- overloaded: format cents, optionally with a currency symbol
CREATE FUNCTION format_price(cents int) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT to_char(cents / 100.0, 'FM999G999D00') $$;

CREATE FUNCTION format_price(cents int, symbol text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT symbol || to_char(cents / 100.0, 'FM999G999D00') $$;

CREATE PROCEDURE refresh_book_sales()
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW book_sales;
END;
$$;
COMMENT ON PROCEDURE refresh_book_sales() IS 'Rebuild the book_sales materialized view';

-- harmless trigger: strips hyphens and spaces from ISBNs on write
CREATE FUNCTION normalize_isbn() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.isbn := regexp_replace(NEW.isbn, '[-\s]', '', 'g');
  RETURN NEW;
END;
$$;

CREATE TRIGGER books_normalize_isbn
BEFORE INSERT OR UPDATE OF isbn ON books
FOR EACH ROW EXECUTE FUNCTION normalize_isbn();

CREATE FUNCTION customer_order_count(p_customer_id bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM orders WHERE customer_id = p_customer_id;
$$;
COMMENT ON FUNCTION customer_order_count(bigint) IS 'Runs with the owner''s privileges so callers need no SELECT on orders';

CREATE AGGREGATE sum_cents(int) (
  SFUNC = int4pl,
  STYPE = int,
  INITCOND = '0'
);

ANALYZE;

-- read-only role, exactly as the README recommends
CREATE ROLE pgstudio_ro LOGIN PASSWORD 'demo_ro';
GRANT CONNECT ON DATABASE bookshop TO pgstudio_ro;
GRANT USAGE ON SCHEMA public TO pgstudio_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgstudio_ro;
