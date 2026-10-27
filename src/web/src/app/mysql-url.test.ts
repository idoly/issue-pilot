import { expect, test } from "vitest";
import { mysqlTargetFromUrl, mysqlTargetUrl } from "./mysql-url";

test("round trips connection fields without changing reserved characters or password spaces", () => {
  const target = { host: "db.example.test", port: 3307, username: "reader@example", password: " p@ss:/?#% ", database: "orders/archive" };
  expect(mysqlTargetFromUrl(mysqlTargetUrl(target))).toEqual(target);
  expect(mysqlTargetFromUrl("mysql://reader:pass@db.example.test/orders").port).toBe(3306);
});

test("round trips IPv6 hosts", () => {
  expect(mysqlTargetFromUrl(mysqlTargetUrl({ host: "[2001:db8::1]", port: 3306, username: "reader", password: "pass", database: "orders" })).host).toBe("[2001:db8::1]");
});

for (const url of ["", "https://reader:pass@db/orders", "jdbc:mysql://db/orders", "mysql://reader@db/orders", "mysql://reader:pass@db/", "mysql://reader:pass@db/orders?ssl=true", "mysql://reader:pass@db/orders#extra", "mysql://reader:pass@db:0/orders", "mysql://reader:pass@db:65536/orders", "mysql://reader:%00@db/orders", "mysql://reader:%ZZ@db/orders"]) test(`rejects unsupported or incomplete URL ${url}`, () => {
  expect(() => mysqlTargetFromUrl(url)).toThrow("invalid_mysql_url");
});
