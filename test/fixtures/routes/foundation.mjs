export default {
  '/fixture/foundation/status': (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ready":true}');
  },
};
