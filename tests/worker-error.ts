import bunline from "../src/index";

bunline.setupThreadWorker(async (_job) => {
  const error = new TypeError("Custom error message");
  error.name = "MyCustomTypeError";
  throw error;
});
