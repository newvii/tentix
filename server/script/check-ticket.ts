import { connectDB } from "@/utils/tools.ts";
import * as schema from "@db/schema.ts";
import { eq } from "drizzle-orm";

const db = connectDB();
const ticket = await db.query.tickets.findFirst({
  where: eq(schema.tickets.id, "94vrsy1m8cm9q"),
});
console.log(JSON.stringify(ticket, null, 2));
