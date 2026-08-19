FROM nginx:alpine
ARG REACT_APP_API_URL=http://localhost:3000
COPY public/index.html /tmp/index.html
RUN sed "s|__API_URL__|${REACT_APP_API_URL}|g" /tmp/index.html > /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
