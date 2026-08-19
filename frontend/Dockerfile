FROM node:20-alpine AS builder

ARG REACT_APP_API_URL=http://localhost:3000
ENV REACT_APP_API_URL=$REACT_APP_API_URL

ARG REACT_APP_CRED_DEF_ID=
ENV REACT_APP_CRED_DEF_ID=$REACT_APP_CRED_DEF_ID

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
ENV DISABLE_ESLINT_PLUGIN=true
RUN npm run build

FROM nginx:alpine AS runner

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
