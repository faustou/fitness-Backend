import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import fetch from "node-fetch"; // Asegurate de tener instalado node-fetch si no lo usás con Node 18+

// SDK de Mercado Pago
import { MercadoPagoConfig, Preference } from "mercadopago";
import { title } from "process";

const client = new MercadoPagoConfig({
  accessToken:
    "TEST-2991514303814212-051318-8a9af58457a70c800bc8bb28b6866492-256864692",
});

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pagosFilePath = path.resolve("pagos.json");

app.get("/", (req, res) => {
  res.send("soy el server");
});

app.post("/create_preference", async (req, res) => {
  try {
    const body = {
      items: [
        {
          title: req.body.title,
          quantity: Number(req.body.quantity),
          unit_price: Number(req.body.price),
          currency_id: "ARS",
        },
      ],
      back_urls: {
        success: "https://www.youtube.com",
        failure: "https://www.youtube.com",
        pending: "https://www.youtube.com",
      },
      auto_return: "approved",
      notification_url:
        "https://511f-2802-8010-4967-bd01-1163-861d-990d-892b.ngrok-free.app/webhook",
    };
    const preference = new Preference(client);
    const result = await preference.create({ body });
    res.json({
      id: result.id,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      error: "error al crear la preferencia",
    });
  }
});

app.post("/webhook", async function (req, res) {
  console.log("✅ Webhook recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.type === "payment") {
    const paymentId = req.body.data?.id;

    if (!paymentId) {
      console.warn("⚠️ Webhook recibido sin ID de pago");
      return res.sendStatus(400);
    }

    try {
      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${client.accessToken}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();

        const resumen = {
          id: data.id,
          descripcion: data.description,
          monto: data.transaction_amount,
          cuotas: data.installments,
          email: data.payer.email,
          dni: data.payer.identification.number,
          ip: data.additional_info.ip_address,
          metodoPago: data.payment_method_id,
          estado: data.status,
          fecha: data.date_created,
        };

        console.log("🧾 RESUMEN DE COMPRA:");
        console.log(resumen);

        let pagos = [];
        if (fs.existsSync(pagosFilePath)) {
          const contenido = fs.readFileSync(pagosFilePath, "utf8");
          pagos = JSON.parse(contenido);
        }

        pagos.push(resumen);
        fs.writeFileSync(pagosFilePath, JSON.stringify(pagos, null, 2));

        return res.sendStatus(200);
      }

      res.sendStatus(500);
    } catch (error) {
      console.error("❌ Error general en webhook:", error);
      res.sendStatus(500);
    }
  } else {
    console.log("🔁 Otro tipo de notificación recibido:", req.body.type);
    res.sendStatus(200);
  }
});

// ✅ NUEVA API para ver los pagos
app.get("/api/pagos", (req, res) => {
  const clave = req.query.clave;

  if (clave !== "1234") {
    return res.status(403).json({ error: "No autorizado" });
  }

  if (!fs.existsSync(pagosFilePath)) {
    return res.json([]);
  }

  const contenido = fs.readFileSync(pagosFilePath, "utf8");
  const pagos = JSON.parse(contenido);
  res.json(pagos);
});

app.listen(port, () => {
  console.log(`el servidor esta corriendo en el puerto ${port}`);
});

app.get("/api/pagos", (req, res) => {
    const clave = req.query.clave;

    if (clave !== "1234") {
        return res.status(403).json({ error: "No autorizado" });
    }

    if (!fs.existsSync(pagosFilePath)) {
        return res.json([]);
    }

    const contenido = fs.readFileSync(pagosFilePath, "utf8");
    const pagos = JSON.parse(contenido);
    res.json(pagos);
});

app.delete("/api/pagos/:id", (req, res) => {
  const clave = req.query.clave;
  if (clave !== "1234") {
    return res.status(403).json({ error: "No autorizado" });
  }

  const id = Number(req.params.id);

  if (!fs.existsSync(pagosFilePath)) {
    return res.status(404).json({ error: "Archivo no encontrado" });
  }

  const contenido = fs.readFileSync(pagosFilePath, "utf8");
  let pagos = JSON.parse(contenido);

  const nuevoListado = pagos.filter((p) => p.id !== id);

  if (pagos.length === nuevoListado.length) {
    return res.status(404).json({ error: "Pago no encontrado" });
  }

  fs.writeFileSync(pagosFilePath, JSON.stringify(nuevoListado, null, 2));
  res.json({ mensaje: "Pago eliminado correctamente" });

  console.log("🗑️ Eliminando pago con ID:", id);
});
